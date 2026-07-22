import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTypeScriptImports,
  loadPackageGraph,
  validatePackageGraph,
  type PackageDescription,
  type PackageGraph,
} from "../../tooling/verification/package-graph.ts";

const root = new URL("../..", import.meta.url).pathname;
const graphPromise = loadPackageGraph(root);

describe("package graph enforcement", () => {
  test("accepts the repository graph", async () => {
    const graph = await graphPromise;
    expect(() => validatePackageGraph(graph)).not.toThrow();
  });

  test("pins every Bun toolchain authority to the runtime version", async () => {
    const graph = await graphPromise;
    const mismatches: ReadonlyArray<PackageGraph> = [
      { ...graph, packageManager: "bun@1.3.14" },
      { ...graph, bunEngine: "1.3.14" },
      {
        ...graph,
        rootDependencyGroups: {
          ...graph.rootDependencyGroups,
          devDependencies: {
            ...graph.rootDependencyGroups.devDependencies,
            "@types/bun": "1.3.14",
          },
        },
      },
      { ...graph, runtimeBunVersion: "1.3.14" },
    ];
    for (const mismatch of mismatches) {
      expect(() => validatePackageGraph(mismatch)).toThrow("Bun toolchain mismatch");
    }
  });

  test("requires exact workspace directories, names, and root glob", async () => {
    const graph = await graphPromise;
    expect(() => validatePackageGraph({ ...graph, packages: graph.packages.slice(1) })).toThrow(
      "directories must be exactly",
    );
    expect(() => validatePackageGraph({ ...graph, rootWorkspaces: ["packages/core"] })).toThrow(
      "workspaces",
    );
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/core", (item) => ({ ...item, name: "@ziggy/renamed" })),
      ),
    ).toThrow("package name");
    expect(() => validatePackageGraph({ ...graph, hasPackagesTestkit: true })).toThrow(
      "packages/testkit",
    );
  });

  test("root product version is exact and every workspace mirrors it", async () => {
    const graph = await graphPromise;
    expect(() => validatePackageGraph({ ...graph, rootVersion: "workspace:*" })).toThrow(
      "root package version must be canonical SemVer",
    );
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/core", (item) => ({ ...item, version: "9.9.9" })),
      ),
    ).toThrow("workspace version must mirror root version");
  });

  test("AST detects every static module form, including template imports", async () => {
    const imports = await collectFixture(`
      import value from "static-package";
      import "side-effect-package";
      export { value } from "export-package";
      export * from "export-all-package";
      import alias = require("equals-package");
      const dynamicValue = import("dynamic-package");
      const templateValue = import(\`template-package\`);
      const dynamicWithOptions = import("dynamic-options-package", {
        with: { type: "json" },
      });
      const required = require("required-package");
      const requiredTemplate = require(\`required-template-package\`);
      const optionalRequired = require?.("optional-required-package");
      const moduleRequired = module.require("module-required-package");
      const moduleRequiredTemplate = module.require(\`module-required-template-package\`);
      const optionalModuleRequired = module.require?.("optional-module-required-package");
      const resolved = require.resolve("resolved-package");
      const resolvedTemplate = require.resolve(\`resolved-template-package\`);
      const optionalResolved = require.resolve?.("optional-resolved-package");
    `);
    expect(imports.map((item) => item.specifier)).toEqual([
      "static-package",
      "side-effect-package",
      "export-package",
      "export-all-package",
      "equals-package",
      "dynamic-package",
      "template-package",
      "dynamic-options-package",
      "required-package",
      "required-template-package",
      "optional-required-package",
      "module-required-package",
      "module-required-template-package",
      "optional-module-required-package",
      "resolved-package",
      "resolved-template-package",
      "optional-resolved-package",
    ]);
  });

  test("AST fails closed on computed import and CommonJS specifiers", async () => {
    await expect(collectFixture("const loaded = import(packageName);")).rejects.toThrow(
      "import specifier must be a static string literal",
    );
    await expect(collectFixture("const loaded = import(`package-${name}`);")).rejects.toThrow(
      "import specifier must be a static string literal",
    );
    for (const source of [
      "const loaded = require(packageName);",
      "const loaded = module.require(packageName);",
      "const loaded = module.require(`package-${name}`);",
      "const loaded = require.resolve(packageName);",
      "const loaded = require.resolve(`package-${name}`);",
    ]) {
      await expect(collectFixture(source)).rejects.toThrow(
        "require specifier must be a static string literal",
      );
    }
  });

  test("permits only the sealed Tool adapter's exact runtime import cutpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ziggy-package-tool-import-"));
    const adapter = join(
      directory,
      "packages",
      "core",
      "src",
      "extensions",
      "tool-loader-node-adapter.ts",
    );
    try {
      await mkdir(join(adapter, ".."), { recursive: true });
      await writeFile(
        adapter,
        "export async function load(entryPath: string) { return import(entryPath); }\n",
      );
      expect(await collectTypeScriptImports(directory, [adapter])).toEqual([]);
      await writeFile(
        adapter,
        "export async function load(otherPath: string) { return import(otherPath); }\n",
      );
      await expect(collectTypeScriptImports(directory, [adapter])).rejects.toThrow(
        "import specifier must be a static string literal",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("AST rejects CommonJS calls with invalid arity", async () => {
    for (const source of [
      "const loaded = require();",
      'const loaded = require("package", { optional: true });',
      "const loaded = module.require();",
      'const loaded = module.require("package", options);',
      "const loaded = require.resolve();",
      'const loaded = require.resolve("package", options);',
    ]) {
      await expect(collectFixture(source)).rejects.toThrow(
        "require must have exactly one specifier argument",
      );
    }
  });

  test("parser diagnostics fail verification", async () => {
    await expect(collectFixture('import { broken from "package";')).rejects.toThrow(
      "Oxc parser diagnostic",
    );
  });

  test("repeated in-process graph parsing completes without subprocess lifecycle", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const graph = await loadPackageGraph(root);
      expect(() => validatePackageGraph(graph)).not.toThrow();
    }
  });

  test("dynamic imports with options cannot bypass dependency or boundary checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ziggy-package-dynamic-options-"));
    const sourceDirectory = join(directory, "packages/core/src");
    const file = join(sourceDirectory, "fixture.ts");
    try {
      await mkdir(sourceDirectory, { recursive: true });
      await Bun.write(
        file,
        `
          const external = import("undeclared-options-package", { with: { type: "json" } });
          const templateExternal = import(\`undeclared-template-package\`);
          const testModule = import("../../../tests/fixture.ts", {
            with: { type: "json" },
          });
          const templateTestModule = import(\`../../../tests/template-fixture.ts\`);
        `,
      );
      const imports = await collectTypeScriptImports(directory, [file]);
      expect(imports.map((item) => item.specifier)).toEqual([
        "undeclared-options-package",
        "undeclared-template-package",
        "../../../tests/fixture.ts",
        "../../../tests/template-fixture.ts",
      ]);

      const repositoryGraph = await graphPromise;
      const graph: PackageGraph = {
        ...repositoryGraph,
        root: directory,
        packages: repositoryGraph.packages.map((item) => ({ ...item, imports: [] })),
      };
      const diagnostics = [
        "external import undeclared-options-package is undeclared",
        "external import undeclared-template-package is undeclared",
        "production import",
        "production import",
      ];
      for (const [index, diagnostic] of diagnostics.entries()) {
        const reference = imports[index];
        if (reference === undefined) {
          throw new Error("missing dynamic import fixture");
        }
        expect(() =>
          validatePackageGraph(
            mutatePackage(graph, "@ziggy/core", (item) => ({
              ...item,
              imports: [reference],
            })),
          ),
        ).toThrow(diagnostic);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects forbidden and undeclared package imports across spelling forms", async () => {
    const graph = await graphPromise;
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/core", (item) => ({
          ...item,
          imports: [
            { sourceFile: "packages/core/src/index.ts", specifier: "../../protocol/src/index.ts" },
          ],
        })),
      ),
    ).not.toThrow();
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/protocol", (item) => ({
          ...item,
          imports: [
            { sourceFile: "packages/protocol/src/index.ts", specifier: "@ziggy/core/subpath" },
          ],
        })),
      ),
    ).toThrow("undeclared");
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/protocol", (item) => ({
          ...item,
          imports: [
            { sourceFile: "packages/protocol/src/index.ts", specifier: "../../core/src/index.ts" },
          ],
        })),
      ),
    ).toThrow("forbidden relative cross-package");
  });

  test("rejects relative production imports outside known workspace packages", async () => {
    const graph = await graphPromise;
    const probes: ReadonlyArray<readonly [string, string]> = [
      ["../../../README.md", "known workspace package"],
      ["../../../../outside-root.ts", "escapes repository"],
      ["../../../tests/testkit/world/contract.ts", "production import"],
      ["../../../tooling/verification/evidence.ts", "production import"],
      ["../../../verification/generated.ts", "production import"],
    ];
    for (const [specifier, diagnostic] of probes) {
      expect(() =>
        validatePackageGraph(
          mutatePackage(graph, "@ziggy/core", (item) => ({
            ...item,
            imports: [{ sourceFile: "packages/core/src/index.ts", specifier }],
          })),
        ),
      ).toThrow(diagnostic);
    }
  });

  test("allows only the core product-version module to import root package.json", async () => {
    const graph = await graphPromise;
    const allowed = {
      sourceFile: "packages/core/src/product-version.ts",
      specifier: "../../../package.json",
    };
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/core", (item) => ({ ...item, imports: [allowed] })),
      ),
    ).not.toThrow();

    for (const reference of [
      { ...allowed, sourceFile: "packages/core/src/index.ts" },
      { ...allowed, specifier: "../../../README.md" },
    ]) {
      expect(() =>
        validatePackageGraph(
          mutatePackage(graph, "@ziggy/core", (item) => ({ ...item, imports: [reference] })),
        ),
      ).toThrow("known workspace package");
    }
  });

  test("accepts Node builtins and rejects undeclared lookalikes", async () => {
    const graph = await graphPromise;
    for (const specifier of [
      "http",
      "module",
      "worker_threads",
      "timers/promises",
      "diagnostics_channel",
      "node:http",
      "node:timers/promises",
    ]) {
      expect(() =>
        validatePackageGraph(
          mutatePackage(graph, "@ziggy/protocol", (item) => ({
            ...item,
            imports: [{ sourceFile: "packages/protocol/src/index.ts", specifier }],
          })),
        ),
      ).not.toThrow();
    }
    for (const specifier of [
      "http-lookalike",
      "module-lookalike",
      "worker_threads-lookalike",
      "timers-lookalike/promises",
      "diagnostics_channel-lookalike",
      "node:http-lookalike",
    ]) {
      expect(() =>
        validatePackageGraph(
          mutatePackage(graph, "@ziggy/protocol", (item) => ({
            ...item,
            imports: [{ sourceFile: "packages/protocol/src/index.ts", specifier }],
          })),
        ),
      ).toThrow("undeclared");
    }
  });

  test("validates all dependency fields, exact versions, and allowed internal edges", async () => {
    const graph = await graphPromise;
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/protocol", (item) =>
          withDependency(item, "optionalDependencies", "@ziggy/core", "workspace:*"),
        ),
      ),
    ).toThrow("forbidden internal edge");
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/core", (item) =>
          withDependency(item, "peerDependencies", "range-only", "^1.0.0"),
        ),
      ),
    ).toThrow("must be exact");
    expect(() =>
      validatePackageGraph(
        mutatePackage(graph, "@ziggy/core", (item) =>
          withDependency(item, "devDependencies", "@effect/schema", "4.0.0-beta.99"),
        ),
      ),
    ).toThrow("forbidden dependency");
    expect(() =>
      validatePackageGraph({
        ...graph,
        rootDependencyGroups: {
          ...graph.rootDependencyGroups,
          devDependencies: { ...graph.rootDependencyGroups.devDependencies, ajv: "~8.20.0" },
        },
      }),
    ).toThrow("must be exact");
  });
});

async function collectFixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "ziggy-package-ast-"));
  const file = join(directory, "fixture.ts");
  try {
    await Bun.write(file, source);
    return await collectTypeScriptImports(directory, [file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mutatePackage(
  graph: PackageGraph,
  name: string,
  mutate: (item: PackageDescription) => PackageDescription,
): PackageGraph {
  return {
    ...graph,
    packages: graph.packages.map((item) => (item.name === name ? mutate(item) : item)),
  };
}

function withDependency(
  item: PackageDescription,
  field: keyof PackageDescription["dependencyGroups"],
  name: string,
  version: string,
): PackageDescription {
  return {
    ...item,
    dependencyGroups: {
      ...item.dependencyGroups,
      [field]: { ...item.dependencyGroups[field], [name]: version },
    },
  };
}

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.mjs";

const executionMethods = new Set([
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
]);

const message =
  "Do not execute Effect inside domain code. Return an Effect and run it only at an approved executable or test adapter boundary. Skill: effect-runtime-boundaries.";

const importedName = (specifier) => specifier.imported?.name ?? specifier.imported?.value;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Keep Effect execution at approved executable and test adapter boundaries.",
    },
  },
  create(context) {
    const namespaces = new Set();
    const directImports = new Set();

    return {
      ImportDeclaration(node) {
        if (node.source.value === "effect") {
          for (const specifier of node.specifiers ?? []) {
            if (importedName(specifier) === "Effect" && specifier.local?.name) {
              namespaces.add(specifier.local.name);
            }
          }
          return;
        }

        if (node.source.value !== "effect/Effect") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type === "ImportNamespaceSpecifier" && specifier.local?.name) {
            namespaces.add(specifier.local.name);
          } else if (executionMethods.has(importedName(specifier)) && specifier.local?.name) {
            directImports.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (isIdentifier(callee) && directImports.has(callee.name)) {
          context.report({ node: callee, message });
          return;
        }
        if (callee?.type !== "MemberExpression") return;
        const object = unwrapExpression(callee.object);
        const property = getPropertyName(callee.property);
        if (isIdentifier(object) && namespaces.has(object.name) && executionMethods.has(property)) {
          context.report({ node: callee, message });
        }
      },
    };
  },
};

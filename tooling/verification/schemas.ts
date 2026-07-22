import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const schemaFiles = [
  "agent-findings-v1.schema.json",
  "evidence-replay-v1.schema.json",
  "evidence-result-v1.schema.json",
  "evidence-result-v2.schema.json",
  "evidence-summary-v1.schema.json",
  "evidence-summary-v2.schema.json",
  "manifest-v1.schema.json",
  "native-service-smoke-v1.schema.json",
  "s4-extension-review-v1.schema.json",
  "s4-merlin-migration-v1.schema.json",
  "scenario-v1.schema.json",
] as const;

type SchemaName = (typeof schemaFiles)[number];

export interface SchemaCatalog {
  validate(name: SchemaName, value: unknown, source: string): void;
}

export async function loadSchemaCatalog(root: string): Promise<SchemaCatalog> {
  const directory = join(root, "verification/schemas");
  const actual = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  if (
    actual.length !== schemaFiles.length ||
    actual.some((file, index) => file !== schemaFiles[index])
  ) {
    throw new Error("verification schema set is incomplete or unsupported");
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", {
    type: "string",
    validate: isCanonicalDateTime,
  });
  const validators = new Map<SchemaName, ValidateFunction>();
  for (const file of schemaFiles) {
    const value = requireRecord(
      parseJson(await Bun.file(join(directory, file)).text(), file),
      file,
    );
    if (!ajv.validateSchema(value)) {
      throw new Error(`${file}: invalid schema: ${ajv.errorsText(ajv.errors)}`);
    }
    const validator = ajv.compile(value);
    validators.set(file, validator);
  }

  return {
    validate(name, value, source) {
      const validator = validators.get(name);
      if (validator === undefined) {
        throw new Error(`unknown verification schema ${name}`);
      }
      if (!validator(value)) {
        throw new Error(`${source}: schema validation failed: ${ajv.errorsText(validator.errors)}`);
      }
    },
  };
}

export async function validateSchemaFiles(root: string): Promise<void> {
  await loadSchemaCatalog(root);
}

function isCanonicalDateTime(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function requireRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: schema must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: invalid JSON`, { cause: error });
  }
}

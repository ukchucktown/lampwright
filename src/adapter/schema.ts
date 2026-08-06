import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type { AdapterDefinitionV1 } from "./types.js";
import { AdapterLoadError } from "./types.js";

const schemaUrl = new URL(
  "../../schemas/adapter-v1.schema.json",
  import.meta.url,
);
let validatorPromise: Promise<ValidateFunction<AdapterDefinitionV1>> | null =
  null;

export async function validateAdapterDefinition(
  input: unknown,
  sourcePath: string | null,
): Promise<AdapterDefinitionV1> {
  if (isRecord(input) && Object.hasOwn(input, "schemaVersion")) {
    const version = input.schemaVersion;
    if (version !== 1) {
      throw new AdapterLoadError(
        "unsupported-version",
        `unsupported adapter schema version: ${String(version)}`,
        sourcePath,
      );
    }
  }

  const validate = await adapterValidator();
  if (!validate(input)) {
    const first = validate.errors?.[0];
    const location = first?.instancePath.length ? first.instancePath : "/";
    const detail = first?.message ?? "adapter does not match the v1 schema";
    throw new AdapterLoadError(
      "schema-invalid",
      `invalid adapter at ${location}: ${detail}`,
      sourcePath,
    );
  }
  return input;
}

async function adapterValidator(): Promise<
  ValidateFunction<AdapterDefinitionV1>
> {
  validatorPromise ??= createValidator();
  return validatorPromise;
}

async function createValidator(): Promise<
  ValidateFunction<AdapterDefinitionV1>
> {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile<AdapterDefinitionV1>(schema);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

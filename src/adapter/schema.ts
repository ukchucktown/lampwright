import { readFile } from "node:fs/promises";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type {
  AdapterDefinition,
  AdapterDefinitionV1,
  AdapterDefinitionV2,
} from "./types.js";
import { AdapterLoadError } from "./types.js";

const schemaV1Url = new URL(
  "../../schemas/adapter-v1.schema.json",
  import.meta.url,
);
const schemaV2Url = new URL(
  "../../schemas/adapter-v2.schema.json",
  import.meta.url,
);

interface AdapterValidators {
  readonly v1: ValidateFunction<AdapterDefinitionV1>;
  readonly v2: ValidateFunction<AdapterDefinitionV2>;
}

let validatorsPromise: Promise<AdapterValidators> | null = null;

export async function validateAdapterDefinition(
  input: unknown,
  sourcePath: string | null,
): Promise<AdapterDefinition> {
  const version = isRecord(input) ? input.schemaVersion : undefined;
  if (version !== undefined && version !== 1 && version !== 2) {
    throw new AdapterLoadError(
      "unsupported-version",
      `unsupported adapter schema version: ${String(version)}`,
      sourcePath,
    );
  }

  const validators = await adapterValidators();
  const validate = version === 2 ? validators.v2 : validators.v1;
  if (!validate(input)) {
    const first = validate.errors?.[0];
    const location = first?.instancePath.length ? first.instancePath : "/";
    const detail =
      first?.message ?? `adapter does not match the v${String(version)} schema`;
    throw new AdapterLoadError(
      "schema-invalid",
      `invalid adapter at ${location}: ${detail}`,
      sourcePath,
    );
  }
  return input as AdapterDefinition;
}

async function adapterValidators(): Promise<AdapterValidators> {
  validatorsPromise ??= createValidators();
  return validatorsPromise;
}

async function createValidators(): Promise<AdapterValidators> {
  const [schemaV1, schemaV2] = await Promise.all(
    [schemaV1Url, schemaV2Url].map(async (url) =>
      JSON.parse(await readFile(url, "utf8")),
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schemaV1);
  return {
    v1: ajv.getSchema<AdapterDefinitionV1>(schemaV1.$id)!,
    v2: ajv.compile<AdapterDefinitionV2>(schemaV2),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

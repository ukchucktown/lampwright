import type { JsonValue } from "./types.js";

export class ModelSerializationError extends TypeError {
  readonly path: readonly (number | string)[];

  constructor(path: readonly (number | string)[], message: string) {
    const label = path.length === 0 ? "value" : path.join(".");
    super(`${label}: ${message}`);
    this.name = "ModelSerializationError";
    this.path = Object.freeze([...path]);
  }
}

export function toDeterministicJson(value: unknown): JsonValue {
  return normalizeJson(value, []);
}

export function stringifyModel(value: unknown, indentation = 2): string {
  if (!Number.isInteger(indentation) || indentation < 0 || indentation > 10) {
    throw new RangeError("indentation must be an integer between 0 and 10");
  }
  return JSON.stringify(toDeterministicJson(value), null, indentation);
}

function normalizeJson(
  value: unknown,
  path: readonly (number | string)[],
): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ModelSerializationError(path, "numbers must be finite");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, [...path, index]));
  }

  if (typeof value !== "object") {
    throw new ModelSerializationError(path, `cannot serialize ${typeof value}`);
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelSerializationError(path, "only plain objects are supported");
  }

  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value as object).sort()) {
    result[key] = normalizeJson((value as Record<string, unknown>)[key], [
      ...path,
      key,
    ]);
  }
  return result;
}

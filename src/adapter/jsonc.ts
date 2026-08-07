import {
  parseTree,
  printParseErrorCode,
  type Node as JsoncNode,
  type ParseError,
} from "jsonc-parser";

import { AdapterLoadError } from "./types.js";

export function parseJsoncAdapter(
  content: string,
  sourcePath: string | null,
): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(content, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (root === undefined || errors.length > 0) {
    const first = errors[0];
    const detail =
      first === undefined
        ? "adapter document is empty"
        : `${printParseErrorCode(first.error)} at offset ${String(first.offset)}`;
    throw new AdapterLoadError(
      "parse-failed",
      `invalid JSONC adapter: ${detail}`,
      sourcePath,
    );
  }

  return nodeValue(root, sourcePath, []);
}

function nodeValue(
  node: JsoncNode,
  sourcePath: string | null,
  path: readonly string[],
): unknown {
  switch (node.type) {
    case "object":
      return objectValue(node, sourcePath, path);
    case "array":
      return (node.children ?? []).map((child, index) =>
        nodeValue(child, sourcePath, [...path, String(index)]),
      );
    case "string":
    case "number":
    case "boolean":
    case "null":
      return node.value;
    default:
      throw new AdapterLoadError(
        "parse-failed",
        `invalid JSONC value at ${displayPath(path)}`,
        sourcePath,
      );
  }
}

function objectValue(
  node: JsoncNode,
  sourcePath: string | null,
  path: readonly string[],
): Record<string, unknown> {
  const value = Object.create(null) as Record<string, unknown>;
  for (const property of node.children ?? []) {
    const keyNode = property.children?.[0];
    const valueNode = property.children?.[1];
    if (
      property.type !== "property" ||
      keyNode?.type !== "string" ||
      typeof keyNode.value !== "string" ||
      valueNode === undefined
    ) {
      throw new AdapterLoadError(
        "parse-failed",
        `invalid JSONC property at ${displayPath(path)}`,
        sourcePath,
      );
    }

    const key = keyNode.value;
    if (Object.hasOwn(value, key)) {
      throw new AdapterLoadError(
        "parse-failed",
        `duplicate JSONC property at ${displayPath([...path, key])}`,
        sourcePath,
      );
    }
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      value: nodeValue(valueNode, sourcePath, [...path, key]),
      writable: true,
    });
  }
  return value;
}

function displayPath(path: readonly string[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

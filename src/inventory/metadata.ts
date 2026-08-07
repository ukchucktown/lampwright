import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

import type {
  InstallationStatus,
  JsonObject,
  SkillDescriptor,
} from "../model/types.js";

export interface ParsedSkillMetadata {
  readonly skill: SkillDescriptor;
  readonly tags: readonly string[];
  readonly status: InstallationStatus;
  readonly metadata: JsonObject;
}

export async function readSkillMetadata(
  skillFilePath: string,
  fallbackName: string,
): Promise<ParsedSkillMetadata> {
  const content = await readFile(skillFilePath, "utf8");
  const frontmatter = extractFrontmatter(content);

  if (frontmatter === null) {
    return {
      skill: { name: fallbackName, description: null },
      tags: [],
      status: "active",
      metadata: { generic: { frontmatter: "absent" } },
    };
  }

  const document = parseDocument(frontmatter, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      skill: { name: fallbackName, description: null },
      tags: [],
      status: "unresolved",
      metadata: { generic: { frontmatter: "invalid" } },
    };
  }

  const value: unknown = document.toJS();
  if (!isStringKeyedRecord(value)) {
    return {
      skill: { name: fallbackName, description: null },
      tags: [],
      status: "unresolved",
      metadata: { generic: { frontmatter: "invalid" } },
    };
  }

  return {
    skill: {
      name: normalizedString(value.name) ?? fallbackName,
      description: normalizedString(value.description),
    },
    tags: normalizedTags(value.tags),
    status: "active",
    metadata: { generic: { frontmatter: "parsed" } },
  };
}

function extractFrontmatter(content: string): string | null {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") {
    return null;
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && (line === "---" || line === "..."),
  );
  return closingIndex === -1 ? null : lines.slice(1, closingIndex).join("\n");
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizedTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(normalizedString).filter(isString))].sort(
    compareText,
  );
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

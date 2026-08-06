#!/usr/bin/env node

import { readFileSync } from "node:fs";

interface PackageMetadata {
  readonly version: string;
}

function readPackageMetadata(): PackageMetadata {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("package.json does not contain a valid version");
  }

  return value as PackageMetadata;
}

const { version } = readPackageMetadata();
const arguments_ = process.argv.slice(2);

if (arguments_.includes("--version") || arguments_.includes("-v")) {
  process.stdout.write(`${version}\n`);
} else {
  process.stdout.write(`skill-cleaner ${version}

Discover and safely remove AI agent skills.

Usage:
  skill-cleaner [options]

Options:
  -h, --help     Show help
  -v, --version  Show version
`);
}

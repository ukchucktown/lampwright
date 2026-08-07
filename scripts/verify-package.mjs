import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || npmCli.length === 0)
  throw new Error("verify-package must be run through an npm script");

const output = execFileSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8" },
);
const packs = JSON.parse(output);
if (!Array.isArray(packs) || packs.length !== 1)
  throw new Error("npm pack returned an unexpected result");
const pack = packs[0];
if (pack.name !== packageJson.name || pack.version !== packageJson.version)
  throw new Error("packed name/version does not match package.json");
if (!Array.isArray(pack.files) || pack.files.length === 0)
  throw new Error("npm pack returned no files");

const files = new Map(pack.files.map((file) => [file.path, file]));
const exactFiles = new Set([
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
]);
const allowedDirectories = ["dist/", "docs/", "schemas/"];
for (const path of files.keys()) {
  if (
    !exactFiles.has(path) &&
    !allowedDirectories.some((directory) => path.startsWith(directory))
  )
    throw new Error(`unintended package file: ${path}`);
  if (
    path.startsWith("src/") ||
    path.startsWith("tests/") ||
    path.startsWith("scripts/") ||
    path.includes("node_modules/") ||
    path.endsWith(".log") ||
    path.includes(".env")
  )
    throw new Error(`forbidden package file: ${path}`);
}

for (const required of [
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/testing/index.d.ts",
  "dist/testing/index.js",
  "docs/release.md",
  "schemas/adapter-v1.schema.json",
  "schemas/cli-v1.schema.json",
]) {
  if (!files.has(required))
    throw new Error(`required package file missing: ${required}`);
}

for (const target of exportedTargets(packageJson.exports)) {
  const path = target.replace(/^\.\//u, "");
  if (!files.has(path))
    throw new Error(`package export is not packed: ${target}`);
}
for (const target of Object.values(packageJson.bin)) {
  const path = target.replace(/^\.\//u, "");
  if (!files.has(path))
    throw new Error(`package executable is not packed: ${target}`);
  if (
    !existsSync(path) ||
    !readFileSync(path, "utf8").startsWith("#!/usr/bin/env node\n")
  )
    throw new Error(`package executable has no Node.js shebang: ${target}`);
}

process.stdout.write(
  `Verified ${pack.id}: ${String(pack.entryCount)} intended files, ${String(pack.size)} packed bytes.\n`,
);

function exportedTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportedTargets);
}

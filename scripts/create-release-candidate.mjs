import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { normalizeNpmPackResult } from "./npm-pack-result.mjs";

const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || npmCli.length === 0)
  throw new Error("release:candidate must be run through an npm script");

const destination = "release";
mkdirSync(destination, { recursive: true });
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expectedName = `${packageJson.name}-${packageJson.version}.tgz`;
const expectedPath = join(destination, expectedName);
if (existsSync(expectedPath))
  throw new Error(`release candidate already exists: ${expectedPath}`);

const output = execFileSync(
  process.execPath,
  [
    npmCli,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    destination,
  ],
  { encoding: "utf8" },
);
const pack = normalizeNpmPackResult(JSON.parse(output), packageJson.name);
if (pack.filename !== expectedName)
  throw new Error("npm pack created an unexpected release candidate");
const digest = createHash("sha256")
  .update(readFileSync(expectedPath))
  .digest("hex");
const digestPath = `${expectedPath}.sha256`;
writeFileSync(digestPath, `${digest}  ${expectedName}\n`, { flag: "wx" });
process.stdout.write(`Created ${expectedPath}\nSHA-256 ${digest}\n`);

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
if (
  process.env.GITHUB_REF_TYPE !== "tag" ||
  process.env.GITHUB_REF_NAME !== `v${version}`
)
  throw new Error(
    "The checked-out package version must match the release tag.",
  );
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the published package check through npm.");

const directory = mkdtempSync(join(tmpdir(), "lampwright-published-"));
try {
  const cli = join(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "lampwright.cmd" : "lampwright",
  );
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { [name]: version },
      scripts: {
        versionCheck: `${cli} --version`,
        helpCheck: `${cli} --help`,
      },
    }),
  );
  const npm = (...args) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(directory, "cache") },
    });
  npm(
    "install",
    "--registry=https://registry.npmjs.org/",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
  );
  const actual = npm("--silent", "run", "versionCheck").trim();
  if (actual !== version)
    throw new Error(`Expected ${version}, received ${actual}.`);
  const help = npm("--silent", "run", "helpCheck");
  if (
    help.split(/\r?\n/u)[0] !== `${name} ${version}` ||
    !help.includes("Usage:")
  )
    throw new Error("The installed CLI did not return help for the release.");
  process.stdout.write(
    `Verified ${name}@${actual} on ${process.platform}.\n${help}`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

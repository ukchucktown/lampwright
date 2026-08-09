import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expectedPackage = `${packageJson.name}@${packageJson.version}`;
const expectedTag = `v${packageJson.version}`;

assertEqual(
  "release confirmation",
  process.env.RELEASE_CONFIRMATION,
  expectedPackage,
);
assertEqual("Git ref type", process.env.GITHUB_REF_TYPE, "tag");
assertEqual("Git tag", process.env.GITHUB_REF_NAME, expectedTag);
assertEqual(
  "GitHub repository",
  process.env.GITHUB_REPOSITORY,
  "ukchucktown/lampwright",
);
assertEqual("repository visibility", process.env.REPOSITORY_PRIVATE, "false");

const [major = 0, minor = 0] = process.versions.node
  .split(".")
  .map((part) => Number(part));
if (major < 22 || (major === 22 && minor < 14))
  throw new Error("npm trusted publishing requires Node.js 22.14.0 or newer");

process.stdout.write(
  `Release authority verified for ${expectedPackage} from ${expectedTag}.\n`,
);

function assertEqual(label, actual, expected) {
  if (actual !== expected)
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`,
    );
}

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  createInventoryScanner,
  type DiscoveryRoot,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
  type InventoryScanner,
} from "../../src/index.js";
import type { IsolatedTestEnvironment } from "./isolated-test-environment.js";

const fixedTime = new Date("2026-08-07T12:00:00.000Z");

export interface MvpEndToEndFixture {
  readonly isolated: IsolatedTestEnvironment;
  readonly scanEnvironment: InventoryScanEnvironment;
  readonly paths: {
    readonly genericReview: string;
    readonly managedReview: string;
    readonly managerLock: string;
    readonly unrelatedSkill: string;
    readonly pluginRoot: string;
    readonly pluginCollateral: string;
    readonly projectSkill: string;
    readonly systemSkill: string;
    readonly brokenLink: string;
    readonly lampwrightState: string;
  };
  createScanner(managerAvailable: boolean): InventoryScanner;
  snapshot(): Promise<readonly string[]>;
}

export async function createMvpEndToEndFixture(
  isolated: IsolatedTestEnvironment,
): Promise<MvpEndToEndFixture> {
  const genericRoot = join(isolated.home, "generic-skills");
  const managerRoot = join(isolated.home, ".agents", "skills");
  const pluginRoot = join(isolated.home, "plugins", "quality-suite");
  const workspaceRoot = join(isolated.workspace, ".agents", "skills");
  const systemRoot = join(isolated.home, "runtime", "system-skills");
  const paths = {
    genericReview: join(genericRoot, "review"),
    managedReview: join(managerRoot, "review"),
    managerLock: join(isolated.state, "skills", ".skill-lock.json"),
    unrelatedSkill: join(genericRoot, "keep-me"),
    pluginRoot,
    pluginCollateral: join(pluginRoot, "commands", "audit.md"),
    projectSkill: join(workspaceRoot, "project-review"),
    systemSkill: join(systemRoot, "runtime-review"),
    brokenLink: join(genericRoot, "broken-review"),
    lampwrightState: join(isolated.state, "lampwright-e2e"),
  } as const;

  await Promise.all([
    writeSkill(paths.genericReview, "review", "standalone review"),
    writeSkill(paths.managedReview, "review", "manager-owned review"),
    writeSkill(paths.unrelatedSkill, "keep-me", "unrelated skill"),
    writeSkill(join(pluginRoot, "skills", "review"), "review", "plugin review"),
    writeSkill(
      paths.projectSkill,
      "project-review",
      "Git-protected project skill",
    ),
    writeSkill(paths.systemSkill, "runtime-review", "System Skill"),
  ]);
  await writeJson(paths.managerLock, {
    version: 3,
    dismissed: { keep: true },
    skills: {
      review: {
        source: "acme/review-tools",
        sourceType: "github",
        sourceUrl: "https://github.com/acme/review-tools.git",
        skillPath: "skills/review",
      },
    },
  });
  await mkdir(dirname(paths.pluginCollateral), { recursive: true });
  await writeFile(paths.pluginCollateral, "# plugin collateral\n", "utf8");
  await mkdir(dirname(paths.brokenLink), { recursive: true });
  await symlink(
    join(isolated.temporary, "missing-review-target"),
    paths.brokenLink,
    process.platform === "win32" ? "junction" : "dir",
  );

  const scanEnvironment: InventoryScanEnvironment = {
    homeDirectory: isolated.home,
    workspaceDirectory: isolated.workspace,
    configDirectory: isolated.config,
    stateDirectory: isolated.state,
    nodeVersion: "24.0.0",
    agentHomeDirectories: {
      "claude-code": join(isolated.temporary, "unused-claude"),
      codex: join(isolated.temporary, "unused-codex"),
      "gemini-cli": join(isolated.temporary, "unused-gemini"),
    },
  };
  const requestRoots: readonly DiscoveryRoot[] = [
    {
      kind: "user",
      path: genericRoot,
      agentId: "fixture-agent",
      adapterId: null,
    },
    {
      kind: "plugin",
      path: pluginRoot,
      agentId: "fixture-agent",
      scope: { kind: "user" },
      plugin: { id: "quality-suite", version: "1.0.0" },
      independentlySelectable: false,
      adapterId: null,
    },
    {
      kind: "system",
      path: systemRoot,
      agentId: "fixture-agent",
      adapterId: null,
    },
  ];

  return {
    isolated,
    scanEnvironment,
    paths,
    createScanner(managerAvailable) {
      const scanner = createInventoryScanner({
        now: () => fixedTime,
        environment: scanEnvironment,
        commandRunner: fixtureCommandRunner(
          isolated.workspace,
          managerAvailable,
        ),
      });
      return {
        scan: (request) =>
          scanner.scan({
            roots: [...requestRoots, ...(request.roots ?? [])],
          }),
      };
    },
    snapshot: () => snapshotTree(isolated.root),
  };
}

function fixtureCommandRunner(
  workspace: string,
  managerAvailable: boolean,
): InventoryCommandRunner {
  return {
    async run(command) {
      if (command.executable === "skills")
        return {
          exitCode: managerAvailable ? 0 : null,
          stdout: managerAvailable ? "1.5.22\n" : "",
        };
      if (command.executable === "fsutil")
        return {
          exitCode: 0,
          stdout: "Reparse Tag Value : 0xa0000003\r\n",
        };
      if (
        command.executable === "git" &&
        command.arguments[0] === "-C" &&
        command.arguments[1] !== undefined
      ) {
        const candidate = command.arguments[1];
        if (!pathIsWithin(workspace, candidate))
          return { exitCode: null, stdout: "" };
        if (
          command.arguments[2] === "rev-parse" &&
          command.arguments[3] === "--show-toplevel"
        )
          return { exitCode: 0, stdout: `${workspace}\n` };
        if (command.arguments[2] === "check-ignore")
          return { exitCode: 1, stdout: "" };
      }
      return { exitCode: null, stdout: "" };
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSkill(
  path: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

async function snapshotTree(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  await visit(root);
  return entries;

  async function visit(path: string): Promise<void> {
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => compare(left.name, right.name));
    for (const child of children) {
      const childPath = join(path, child.name);
      const displayPath = relative(root, childPath).split(sep).join("/");
      const stats = await lstat(childPath);
      if (stats.isSymbolicLink()) {
        entries.push(`link:${displayPath}:${await readlink(childPath)}`);
      } else if (stats.isDirectory()) {
        entries.push(`directory:${displayPath}`);
        await visit(childPath);
      } else {
        entries.push(
          `file:${displayPath}:${createHash("sha256")
            .update(await readFile(childPath))
            .digest("hex")}`,
        );
      }
    }
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

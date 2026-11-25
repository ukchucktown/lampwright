import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { runCli, formatCliOutput } from "../src/cli.js";
import {
  createAddAgentModule,
  createInventoryScanner,
  plan,
  renderTui,
  plainTuiTheme,
  TuiController,
} from "../src/index.js";
import { nodeArtifactFileSystem } from "../src/filesystem/artifact-filesystem.js";
import { inspectGitProtection } from "../src/inventory/git-protection.js";
import { systemCommandRunner } from "../src/inventory/process.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createEnvironment = createIsolatedTestEnvironmentFixture();
async function fixture() {
  const { home, workspace } = await createEnvironment();
  const source = join(home, ".agents", "skills", "review");
  const destination = join(home, ".gemini", "config", "skills", "review");
  await mkdir(source, { recursive: true });
  const skillFile = join(source, "SKILL.md");
  const bytes = "---\nname: review\ndescription: Review code\n---\noriginal\n";
  await writeFile(skillFile, bytes);
  const lockFile = join(home, ".agents", ".skill-lock.json");
  const record = JSON.stringify({
    version: 3,
    skills: { review: { source: "/fixture/source", sourceType: "local" } },
  });
  await writeFile(lockFile, record);
  const scanner = createInventoryScanner({
    environment: { homeDirectory: home, workspaceDirectory: workspace },
    now: () => new Date(),
    commandRunner: {
      run: async (command) =>
        command.executable === "git"
          ? systemCommandRunner.run(command)
          : command.executable === "fsutil"
            ? { exitCode: 0, stdout: "Reparse Tag Value : 0xa0000003\r\n" }
            : { exitCode: 1, stdout: "" },
    },
  });
  const scan = () => scanner.scan({});
  const addAgent = createAddAgentModule({
    scan,
    fileSystem: nodeArtifactFileSystem,
    inspectGit: (path, creatingDirectory) =>
      inspectGitProtection(path, false, systemCommandRunner, creatingDirectory),
  });
  const inventory = await scan();
  const installation = inventory.installations[0]!;
  const command = [
    "add-agent",
    `installation:${installation.id}`,
    "antigravity-cli",
  ];
  return {
    home,
    source,
    destination,
    skillFile,
    bytes,
    lockFile,
    record,
    inventory,
    installation,
    addAgent,
    scan,
    command,
  };
}

describe("Add agent", () => {
  it("reviews one shared Antigravity destination, preserves the Skill and Owner, and verifies both agents", async () => {
    const f = await fixture();
    const existing = join(f.home, ".claude", "skills", "review");
    await mkdir(dirname(existing), { recursive: true });
    await symlink(
      f.source,
      existing,
      process.platform === "win32" ? "junction" : "dir",
    );
    const dryRun = await runCli([...f.command, "--dry-run"], f);
    expect(dryRun).toMatchObject({
      exitCode: 0,
      output: {
        kind: "add-agent-plan",
        plan: {
          skill: "review",
          scope: { kind: "user" },
          action: "link",
          destination: f.destination,
          agents: ["antigravity", "antigravity-cli"],
        },
      },
    });
    const confirmation = await runCli(f.command, f);
    expect(confirmation).toMatchObject({
      exitCode: 3,
      output: { kind: "confirmation-required" },
    });
    expect(formatCliOutput(confirmation.output, false)).toContain(
      f.destination,
    );
    await expect(lstat(join(f.home, ".gemini"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const applied = await runCli([...f.command, "--yes"], f);
    expect(applied).toMatchObject({
      exitCode: 0,
      output: { kind: "add-agent-report", report: { status: "added" } },
    });
    expect(await realpath(existing)).toBe(f.source);
    expect(await realpath(f.destination)).toBe(f.source);
    expect(await readFile(f.skillFile, "utf8")).toBe(f.bytes);
    expect(await readFile(f.lockFile, "utf8")).toBe(f.record);
    const final = (await f.scan()).installations[0]!;
    expect(final.exposedTo).toEqual(
      expect.arrayContaining([
        "antigravity",
        "antigravity-cli",
        "claude-code",
        "universal",
      ]),
    );
    expect(
      final.removal.supplementalArtifacts?.filter(
        (item) => item.location.path === f.destination,
      ),
    ).toHaveLength(1);
    expect(await runCli([...f.command, "--yes"], f)).toMatchObject({
      exitCode: 0,
      output: { report: { status: "unchanged" } },
    });
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/cli-v1.schema.json", import.meta.url),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv2020({ strict: true }).compile(schema);
    for (const response of [dryRun, confirmation, applied])
      expect(validate(response.output), JSON.stringify(validate.errors)).toBe(
        true,
      );
  });
  it("rejects forged and stale plans without overwriting an occupied destination", async () => {
    const f = await fixture();
    const plan = await f.addAgent.preview(
      f.inventory,
      f.installation,
      "antigravity-cli",
    );
    expect(
      (await f.addAgent.execute({ ...plan, destination: f.lockFile }, true))
        .status,
    ).toBe("blocked");
    await mkdir(dirname(f.destination), { recursive: true });
    await writeFile(f.destination, "user file");
    expect((await f.addAgent.execute(plan, true)).status).toBe("blocked");
    expect(await runCli([...f.command, "--yes"], f)).toMatchObject({
      exitCode: 3,
      output: { plan: { action: "blocked" } },
    });
    expect(await readFile(f.destination, "utf8")).toBe("user file");
  });
  it("blocks a linked parent and unignored Git paths, then permits an ignored destination", async () => {
    const f = await fixture();
    const other = join(f.home, "unrelated");
    await mkdir(other);
    const config = join(f.home, ".gemini");
    await symlink(
      other,
      config,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await runCli([...f.command, "--yes"], f)).toMatchObject({
      exitCode: 3,
      output: { plan: { action: "blocked" } },
    });
    await expect(lstat(join(other, "config"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const git = await fixture();
    execFileSync("git", ["init", "--quiet", git.home]);
    expect(await runCli([...git.command, "--yes"], git)).toMatchObject({
      exitCode: 3,
      output: { plan: { reason: expect.stringContaining("Git protects") } },
    });
    await writeFile(join(git.home, ".gitignore"), ".gemini/\n");
    expect(await runCli([...git.command, "--yes"], git)).toMatchObject({
      exitCode: 0,
      output: { report: { status: "added" } },
    });
  });
  it("opens the terminal agent picker, previews the shared path, and confirms explicitly", async () => {
    const f = await fixture();
    const controller = new TuiController(
      {
        scan: f.scan,
        addAgent: f.addAgent,
        plan,
        execute: () => {
          throw new Error("unexpected removal");
        },
      },
      { rows: 24, columns: 90 },
    );
    await controller.start();
    await controller.dispatch({ kind: "add-agent" });
    const picker = controller.state;
    expect(picker.screen).toBe("add-agent");
    if (picker.screen !== "add-agent") throw new Error("No agent picker");
    await controller.dispatch({
      kind: "move",
      delta: picker.agents.indexOf("antigravity-cli"),
    });
    await controller.dispatch({ kind: "select" });
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "antigravity, antigravity-cli",
    );
    await expect(lstat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await controller.dispatch({ kind: "confirm" });
    expect(controller.state).toMatchObject({
      screen: "browse",
      model: {
        notice: expect.stringContaining("available to antigravity-cli"),
      },
    });
    expect(await realpath(f.destination)).toBe(f.source);
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  mouseAction,
  parseMouseReport,
  parseRawTuiAction,
} from "../src/tui/terminal.js";
import { runCli, formatCliOutput } from "../src/cli.js";
import {
  createAddAgentModule,
  createInventoryScanner,
  plan,
  parseInventory,
  installedAgentIds,
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
    workspace,
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

function controllerFor(f: Awaited<ReturnType<typeof fixture>>) {
  return new TuiController(
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
  it("reviews one action per destination and verifies a batch after its own writes", async () => {
    const f = await fixture();
    const checked = ["claude-code", "antigravity-cli", "antigravity"];
    const plan = await f.addAgent.previewBatch(
      f.inventory,
      f.installation,
      checked,
    );
    expect(plan.destinations).toHaveLength(2);
    expect(plan.selectedAgents).toEqual([
      "antigravity",
      "antigravity-cli",
      "claude-code",
    ]);
    expect((await f.addAgent.executeBatch(plan, false)).status).toBe("blocked");
    expect(
      (await f.addAgent.executeBatch(plan, true)).results.map(
        (result) => result.status,
      ),
    ).toEqual(["added", "added"]);
    expect(await realpath(f.destination)).toBe(f.source);
    expect(await realpath(join(f.home, ".claude", "skills", "review"))).toBe(
      f.source,
    );
  });

  it("blocks the whole batch when a later destination is occupied", async () => {
    const f = await fixture();
    const claude = join(f.home, ".claude", "skills", "review");
    const plan = await f.addAgent.previewBatch(f.inventory, f.installation, [
      "antigravity-cli",
      "claude-code",
    ]);
    await mkdir(dirname(claude), { recursive: true });
    await writeFile(claude, "occupied");
    expect((await f.addAgent.executeBatch(plan, true)).status).toBe("blocked");
    await expect(lstat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const fresh = await f.scan();
    const blocked = await f.addAgent.previewBatch(
      fresh,
      fresh.installations[0]!,
      plan.selectedAgents,
    );
    expect(blocked.destinations.map((action) => action.action)).toContain(
      "blocked",
    );
    expect((await f.addAgent.executeBatch(blocked, true)).status).toBe(
      "blocked",
    );
    await expect(lstat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a partial batch and preserves the verified link if a later write fails", async () => {
    const f = await fixture();
    const module = createAddAgentModule({
      scan: f.scan,
      inspectGit: (path) =>
        inspectGitProtection(path, false, systemCommandRunner),
      fileSystem: {
        ...nodeArtifactFileSystem,
        symlink: async (source, destination, type) => {
          if (destination.includes(".claude"))
            throw new Error("write failed in fixture");
          await nodeArtifactFileSystem.symlink(source, destination, type);
        },
      },
    });
    const plan = await module.previewBatch(f.inventory, f.installation, [
      "antigravity-cli",
      "claude-code",
    ]);
    const report = await module.executeBatch(plan, true);
    expect(report).toMatchObject({
      status: "partial",
      results: [
        { status: "added" },
        { status: "failed", message: "write failed in fixture" },
      ],
    });
    expect(await realpath(f.destination)).toBe(f.source);
  });
  it("hides confirmed copies, links and canonical readers while leaving a conflicting directory for review", async () => {
    const f = await fixture();
    const claude = join(f.home, ".claude", "skills", "review");
    await mkdir(dirname(claude), { recursive: true });
    await symlink(
      f.source,
      claude,
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(dirname(f.destination), { recursive: true });
    await cp(f.source, f.destination, { recursive: true });
    const occupied = join(f.home, ".qwen", "skills", "review");
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "SKILL.md"), f.bytes);
    await writeFile(join(occupied, "private.txt"), "from another installation");
    const outside = join(f.home, "other-agent");
    await mkdir(join(outside, "skills"), { recursive: true });
    await cp(f.source, join(outside, "skills", "review"), { recursive: true });
    await symlink(
      outside,
      join(f.home, ".augment"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const controller = controllerFor(f);
    await controller.start();
    await controller.dispatch({ kind: "add-agent" });
    expect(controller.state).toMatchObject({ screen: "add-agent" });
    if (controller.state.screen !== "add-agent")
      throw new Error("Expected agent picker");
    expect(controller.state.agents).not.toContain("claude-code");
    expect(controller.state.agents).not.toContain("codex");
    expect(controller.state.agents).not.toContain("antigravity-cli");
    expect(controller.state.agents).not.toContain("antigravity");
    expect(controller.state.agents).toContain("qwen-code");
    expect(controller.state.agents).toContain("augment");
    await controller.dispatch({ kind: "append-query", value: "cli" });
    const mixed = renderTui(controller.state, plainTuiTheme);
    expect(mixed).toMatch(/\d+ to add · \d+ installed/u);
    expect(mixed).not.toContain("[ ] antigravity-cli");
    await controller.dispatch({ kind: "clear-query" });
    await controller.dispatch({ kind: "append-query", value: "agy" });
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "Antigravity CLI already has this skill",
    );
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "select" });
    expect(controller.state.plan).toBe(null);
    await controller.dispatch({ kind: "clear-query" });
    await controller.dispatch({ kind: "append-query", value: "misspelled" });
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "No matching agents",
    );
    await controller.dispatch({ kind: "clear-query" });
    await controller.dispatch({ kind: "append-query", value: "qwen" });
    await controller.dispatch({ kind: "select" });
    expect(controller.state.plan).toMatchObject({
      destinations: [{ action: "blocked" }],
    });
    expect(await readFile(join(occupied, "private.txt"), "utf8")).toBe(
      "from another installation",
    );
    expect(await runCli([...f.command, "--yes"], f)).toMatchObject({
      exitCode: 3,
      output: { plan: { action: "blocked" } },
    });
  });

  it("recognizes a project copy that matches its Manager record despite ignored local files", async () => {
    const f = await fixture();
    const source = join(f.workspace, ".agents", "skills", "review");
    const copy = join(f.workspace, ".claude", "skills", "review");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), f.bytes);
    await mkdir(dirname(copy), { recursive: true });
    await cp(source, copy, { recursive: true });
    // The Vercel version 1 project hash excludes node_modules.
    await mkdir(join(copy, "node_modules"));
    await writeFile(
      join(copy, "node_modules", "local.txt"),
      "unrelated local content",
    );
    const computedHash = createHash("sha256")
      .update("SKILL.md")
      .update(f.bytes)
      .digest("hex");
    await writeFile(
      join(f.workspace, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: { source: "acme/skills", sourceType: "github", computedHash },
        },
      }),
    );
    const project = (await f.scan()).installations.find(
      (item) => item.scope.kind === "workspace",
    )!;
    expect(
      project.agentDestinations?.find((item) => item.path === copy),
    ).toMatchObject({ verifiedCopy: true });
    expect(installedAgentIds(project)).toContain("claude-code");
  });
  it("still reads saved Inventory without copy evidence", async () => {
    const f = await fixture();
    await mkdir(dirname(f.destination), { recursive: true });
    await cp(f.source, f.destination, { recursive: true });
    const fresh = await f.scan();
    const old = parseInventory(
      JSON.parse(
        JSON.stringify(fresh, (key, value: unknown) =>
          key === "verifiedCopy" ? undefined : value,
        ),
      ),
    );
    expect(installedAgentIds(old.installations[0]!)).toContain("codex");
    expect(installedAgentIds(old.installations[0]!)).not.toContain(
      "antigravity-cli",
    );
    expect(installedAgentIds(fresh.installations[0]!)).toContain(
      "antigravity-cli",
    );
  });

  it("reports when every supported agent already has the Skill and creates no plan", async () => {
    const f = await fixture();
    for (const { path } of f.installation.agentDestinations!) {
      const withinHome = relative(f.home, path);
      if (withinHome.startsWith("..") || isAbsolute(withinHome))
        throw new Error("Expected fixture path");
      if (path === f.source) continue;
      await mkdir(dirname(path), { recursive: true });
      await symlink(
        f.source,
        path,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const controller = controllerFor(f);
    await controller.start();
    await controller.dispatch({ kind: "add-agent" });
    expect(controller.state).toMatchObject({ screen: "add-agent", agents: [] });
    const frame = () => renderTui(controller.state, plainTuiTheme);
    expect(frame()).toContain("All supported agents already have this skill");
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 10, columns: 32 },
    });
    expect(frame()).toContain("All agents installed");
    expect(frame()).not.toContain("none to…");
    await controller.dispatch({ kind: "append-query", value: "agy" });
    expect(frame()).toContain("Already installed");

    expect(frame()).not.toContain("space select · enter review");
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "select" });
    expect(controller.state).toMatchObject({ plan: null });
  });
  it.each([10, 24])(
    "keeps checked agents across filters at %i rows",
    async (rows) => {
      const f = await fixture();
      const controller = controllerFor(f);
      await controller.start();
      const press = async (text: string, name = text) =>
        controller.dispatch(
          parseRawTuiAction(controller.state, text, {
            name,
            ctrl: false,
            meta: false,
            shift: false,
          }),
        );
      await controller.dispatch({
        kind: "viewport",
        viewport: { rows, columns: 80 },
      });
      expect(
        renderTui(controller.state, plainTuiTheme).split("\n")[1],
      ).toContain("+ add agent");
      await press("+");
      const frame = () => renderTui(controller.state, plainTuiTheme);
      expect(frame()).toContain("┌");
      expect(frame()).toContain("0 selected");
      const searchRow = frame()
        .split("\n")
        .findIndex((line) => line.includes("Search:"));
      const borderRow = frame()
        .split("\n")
        .findIndex((line) => line.includes("┌"));
      expect(borderRow).toBeGreaterThanOrEqual(2);
      expect(searchRow - borderRow).toBe(rows === 10 ? 1 : 2);
      for (const char of "agy") await press(char);
      expect(frame()).toContain("antigravity-cli");
      expect(frame()).toContain("1 match");
      expect(frame()).not.toContain("1 matches");
      expect(frame()).toContain("ctrl+u clear");
      const lines = frame().split("\n");
      expect(lines.findIndex((line) => line.includes("Search:"))).toBe(
        searchRow,
      );
      const row = lines.findIndex((line) =>
        line.includes("antigravity-cli (agy)"),
      );
      const column = lines[row]!.indexOf("[ ]");
      const click = async (x: number, y: number) => {
        const event = parseMouseReport(`\u001b[<0;${x};${y}M`)!;
        await controller.dispatch(
          mouseAction(controller.state, event, {
            dragging: false,
            doubleClick: false,
          }),
        );
      };
      await click(1, 1);
      expect(frame()).toContain("0 selected");
      await click(column + 1, row + 1);
      expect(frame()).toContain("1 selected");
      await controller.dispatch(
        parseRawTuiAction(controller.state, "", {
          name: "u",
          ctrl: true,
          meta: false,
          shift: false,
        }),
      );
      for (const char of "claude") await press(char);
      await press(" ", "space");
      expect(frame()).toContain("2 selected");
      for (let i = 0; i < 6; i++) await press("", "backspace");
      await press("q");
      expect(controller.state).toMatchObject({
        screen: "add-agent",
        query: "q",
      });
      for (const char of "wen") await press(char);
      expect(frame()).toContain("qwen-code");
      await press("", "return");
      expect(controller.state).toMatchObject({
        plan: { selectedAgents: ["antigravity-cli", "claude-code"] },
      });
      await expect(lstat(f.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await press("", "escape");
      expect(frame()).toContain("2 selected");
      await press("", "return");
      await press("y");
      expect(frame()).toContain("Applying and verifying");
      await press("y");
      await Promise.all([
        controller.waitForAddAgentExecution(),
        controller.waitForAddAgentExecution(),
      ]);
      expect(await realpath(f.destination)).toBe(f.source);
      expect(await realpath(join(f.home, ".claude", "skills", "review"))).toBe(
        f.source,
      );
    },
  );
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
  it.each([false, true])(
    "resolves the Skill row across user and workspace Installations (eligible workspace: %s)",
    async (eligibleWorkspace) => {
      const f = await fixture();
      const skills = {
        review: {
          source: "acme/toolkit",
          sourceType: "github",
          skillPath: "skills/review",
        },
      };
      await writeFile(f.lockFile, JSON.stringify({ version: 3, skills }));
      await writeFile(
        join(f.workspace, "skills-lock.json"),
        JSON.stringify({ version: 1, skills }),
      );
      const workspaceSource = join(f.workspace, ".agents", "skills", "review");
      if (eligibleWorkspace) {
        await mkdir(workspaceSource, { recursive: true });
        await writeFile(join(workspaceSource, "SKILL.md"), f.bytes);
      }
      const inventory = await f.scan();
      expect(inventory.logicalSkills).toHaveLength(1);
      expect(inventory.logicalSkills[0]!.installationIds).toHaveLength(2);
      const controller = controllerFor(f);
      await controller.start();
      await controller.dispatch({ kind: "add-agent" });
      if (eligibleWorkspace) {
        expect(renderTui(controller.state, plainTuiTheme)).toContain(
          "Choose an Installation",
        );
        const layout = renderTui(controller.state, plainTuiTheme);
        const lines = layout.split("\n");
        const header = lines.find((line) =>
          line.includes("┌  Choose an Installation"),
        )!;
        const left = header.indexOf("┌"),
          right = header.indexOf("┐");
        const choices = lines
          .filter((line) => line[left] === "│" && line[right] === "│")
          .map((line) => line.slice(left + 3, right - 2))
          .join("");
        expect(choices.replace(/\s/g, "")).toContain(
          workspaceSource.replace(/\s/g, ""),
        );
        expect(layout).toContain("workspace");
        expect(layout).toContain("user");
        await controller.dispatch({ kind: "move", delta: 1 });
        await controller.dispatch({ kind: "select" });
      }
      expect(controller.state).toMatchObject({
        screen: "add-agent",
        installation: {
          location: { path: eligibleWorkspace ? workspaceSource : f.source },
        },
      });
      if (eligibleWorkspace) {
        const viewport = { rows: 20, columns: 75 };
        await controller.dispatch({ kind: "viewport", viewport });
        await controller.dispatch(
          parseRawTuiAction(controller.state, "", {
            name: "escape",
            ctrl: false,
            meta: false,
            shift: false,
          }),
        );
        expect(controller.state).toMatchObject({
          screen: "add-agent-installation",
          index: 1,
          browse: { model: { viewport } },
        });
        await controller.dispatch(
          parseRawTuiAction(controller.state, "", {
            name: "escape",
            ctrl: false,
            meta: false,
            shift: false,
          }),
        );
        expect(controller.state).toMatchObject({
          screen: "browse",
          model: { viewport },
        });
      }
      expect(
        await runCli(
          [
            "add-agent",
            `logical-skill:${inventory.logicalSkills[0]!.id}`,
            "antigravity-cli",
            "--yes",
          ],
          f,
        ),
      ).toMatchObject({ exitCode: 2 });
    },
  );
  it("keeps a multi-Skill selection in Inventory", async () => {
    const f = await fixture();
    const other = join(dirname(f.source), "second");
    await mkdir(other);
    await writeFile(join(other, "SKILL.md"), "---\nname: second\n---\n");
    const entry = { source: "acme/toolkit", sourceType: "github" };
    await writeFile(
      f.lockFile,
      JSON.stringify({ version: 3, skills: { review: entry, second: entry } }),
    );
    const controller = controllerFor(f);
    await controller.start();
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "add-agent" });
    expect(controller.state).toMatchObject({
      screen: "browse",
      model: { notice: expect.stringContaining("one installed Skill") },
    });
  });
  it.each([false, true])(
    "opens the terminal agent picker and confirms explicitly (staged row: %s)",
    async (staged) => {
      const f = await fixture();
      const controller = controllerFor(f);
      await controller.start();
      if (staged) {
        await controller.dispatch({ kind: "focus", pane: "entries" });
        await controller.dispatch(
          parseRawTuiAction(controller.state, " ", {
            name: "space",
            ctrl: false,
            meta: false,
            shift: false,
          }),
        );
      }
      await controller.dispatch(
        parseRawTuiAction(controller.state, "+", {
          name: "+",
          ctrl: false,
          meta: false,
          shift: true,
        }),
      );
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
      await controller.waitForAddAgentExecution();
      expect(controller.state).toMatchObject({
        screen: "browse",
        model: {
          notice: expect.stringContaining("available to antigravity-cli"),
        },
      });
      expect(await realpath(f.destination)).toBe(f.source);
    },
  );
});

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
import { basename, dirname, join, relative, isAbsolute, sep } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
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
  searchLayout,
  plainTuiTheme,
  TuiController,
  type InventoryCommandRunner,
  type TuiAddAgentState,
  type AddAgentBatchPlan,
  type AddAgentBatchReport,
} from "../src/index.js";
import {
  buildSystemSkillFinding,
  buildPluginBoundary,
  buildInstallation,
} from "../src/testing/model-builders.js";
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
  const commandRunner: InventoryCommandRunner = {
    run: async (command) =>
      command.executable === "git"
        ? systemCommandRunner.run(command)
        : command.executable === "fsutil"
          ? { exitCode: 0, stdout: "Reparse Tag Value : 0xa0000003\r\n" }
          : { exitCode: 1, stdout: "" },
  };
  const scanner = createInventoryScanner({
    environment: { homeDirectory: home, workspaceDirectory: workspace },
    now: () => new Date(),
    commandRunner,
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
    commandRunner,
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
  it.each(["failed", "partial"] as const)(
    "retains the selection, executes once and displays a %s result",
    async (status) => {
      type Review = Extract<TuiAddAgentState, { stage: "review" }>;
      type Execution = Extract<TuiAddAgentState, { stage: "execution" }>;
      type Result = Extract<TuiAddAgentState, { stage: "result" }>;
      expectTypeOf<Review["plan"]>().toEqualTypeOf<AddAgentBatchPlan>();
      expectTypeOf<Execution["plan"]>().toEqualTypeOf<AddAgentBatchPlan>();
      expectTypeOf<Result["report"]>().toEqualTypeOf<AddAgentBatchReport>();
      expectTypeOf<Execution>().not.toHaveProperty("report");
      expectTypeOf<Result>().not.toHaveProperty("plan");
      expectTypeOf<
        Extract<TuiAddAgentState, { stage: "selection" }>
      >().not.toHaveProperty("plan");
      const f = await fixture();
      const report: AddAgentBatchReport = {
        status,
        message: "Fixture result",
        results: [
          {
            destination: f.destination,
            agents: ["antigravity", "antigravity-cli"],
            status: status === "partial" ? "added" : "failed",
            message: status === "partial" ? "Verified link" : "Write failed",
          },
          {
            destination: join(f.home, ".claude", "skills", "review"),
            agents: ["claude-code"],
            status: "failed",
            message: "Write failed",
          },
        ],
      };
      const executeBatch = vi.fn(async () => report);
      const controller = controllerFor({
        ...f,
        addAgent: { ...f.addAgent, executeBatch },
      });
      await controller.start();
      await controller.dispatch({ kind: "add-agent" });
      await controller.dispatch({ kind: "append-query", value: "claude" });
      await controller.dispatch({ kind: "toggle-select" });
      await controller.dispatch({ kind: "clear-query" });
      await controller.dispatch({ kind: "append-query", value: "agy" });
      await controller.dispatch({ kind: "toggle-select" });
      const selection = controller.state;
      expect(selection).toMatchObject({ stage: "selection" });
      await controller.dispatch({ kind: "select" });
      expect(controller.state).toMatchObject({
        stage: "review",
        plan: { selectedAgents: ["antigravity-cli", "claude-code"] },
      });
      await controller.dispatch({ kind: "cancel" });
      expect(controller.state).toEqual(selection);
      expect(controller.state).not.toHaveProperty("plan");
      await controller.dispatch({ kind: "select" });
      await controller.dispatch({ kind: "confirm" });
      expect(controller.state).toMatchObject({
        stage: "execution",
        plan: { selectedAgents: ["antigravity-cli", "claude-code"] },
      });
      await controller.dispatch({ kind: "confirm" });
      await Promise.all([
        controller.waitForAddAgentExecution(),
        controller.waitForAddAgentExecution(),
      ]);
      expect(executeBatch).toHaveBeenCalledTimes(1);
      expect(controller.state).toMatchObject({ stage: "result", report });
      expect(controller.state).not.toHaveProperty("plan");
      expect(renderTui(controller.state, plainTuiTheme)).toContain(
        "Fixture result",
      );
      await controller.dispatch({ kind: "confirm" });
      expect(executeBatch).toHaveBeenCalledTimes(1);
      await controller.dispatch({ kind: "cancel" });
      expect(controller.state).toMatchObject({ screen: "browse" });
    },
  );

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
  it.each(["file", "directory", "other-link", "correct-link"])(
    "rechecks a racing %s at the destination",
    async (kind) => {
      const f = await fixture();
      const mod = createAddAgentModule({
        scan: f.scan,
        inspectGit: (path) =>
          inspectGitProtection(path, false, systemCommandRunner),
        fileSystem: {
          ...nodeArtifactFileSystem,
          async symlink(source, destination, type) {
            if (kind === "file") await writeFile(destination, "untouched");
            else if (kind === "directory") await mkdir(destination);
            else
              await nodeArtifactFileSystem.symlink(
                kind === "correct-link" ? source : f.workspace,
                destination,
                type,
              );
            throw Object.assign(new Error("entry already exists"), {
              code: "EEXIST",
            });
          },
        },
      });
      const plan = await mod.previewBatch(f.inventory, f.installation, [
        "antigravity-cli",
      ]);
      const report = await mod.executeBatch(plan, true);
      expect(report).toMatchObject({
        status: kind === "correct-link" ? "succeeded" : "blocked",
        results: [
          { status: kind === "correct-link" ? "unchanged" : "blocked" },
        ],
      });
      if (kind === "file")
        expect(await readFile(f.destination, "utf8")).toBe("untouched");
      if (kind === "other-link")
        expect(await realpath(f.destination)).toBe(f.workspace);
    },
  );

  it.each(["EPERM", "EACCES"])(
    "reports a %s from the actual link as blocked for every destination",
    async (code) => {
      const f = await fixture();
      const mod = createAddAgentModule({
        scan: f.scan,
        inspectGit: (path) =>
          inspectGitProtection(path, false, systemCommandRunner),
        fileSystem: {
          ...nodeArtifactFileSystem,
          async symlink() {
            throw Object.assign(new Error("permission denied"), { code });
          },
        },
      });
      const plan = await mod.previewBatch(f.inventory, f.installation, [
        "antigravity-cli",
        "claude-code",
      ]);
      expect(await mod.executeBatch(plan, true)).toMatchObject({
        status: "blocked",
        results: [{ status: "blocked" }, { status: "blocked" }],
      });
      await expect(lstat(f.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("uses the injected directory write check during preview without creating files", async () => {
    const f = await fixture();
    const mod = createAddAgentModule({
      scan: f.scan,
      inspectGit: (path) =>
        inspectGitProtection(path, false, systemCommandRunner),
      fileSystem: {
        ...nodeArtifactFileSystem,
        async checkDirectoryWritable() {
          throw Object.assign(new Error("fixture access denied"), {
            code: "EACCES",
          });
        },
      },
    });
    expect(
      await mod.preview(f.inventory, f.installation, "antigravity-cli"),
    ).toMatchObject({
      action: "blocked",
      reason: expect.stringContaining("fixture access denied"),
    });
    await expect(lstat(dirname(f.destination))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("executes the refreshed second plan after creating a shared parent", async () => {
    const f = await fixture();
    const shared = join(f.home, "new");
    const requests: string[] = [];
    const environment = {
      homeDirectory: f.home,
      workspaceDirectory: f.workspace,
      agentHomeDirectories: {
        "claude-code": join(shared, "claude"),
        grok: join(shared, "grok"),
      },
    };
    const scanner = createInventoryScanner({
      environment,
      now: () => new Date(),
      commandRunner: f.commandRunner,
      executablePresent: async () => false,
    });
    const scan = () => scanner.scan({});
    const mod = createAddAgentModule({
      scan,
      inspectGit: (path) =>
        inspectGitProtection(path, false, systemCommandRunner),
      fileSystem: {
        ...nodeArtifactFileSystem,
        async mkdir(path) {
          requests.push(path);
          await nodeArtifactFileSystem.mkdir(path);
        },
      },
    });
    const inventory = await scan();
    const selected = inventory.installations.find(
      (item) => item.id === f.installation.id,
    )!;
    const plan = await mod.previewBatch(inventory, selected, [
      "grok",
      "claude-code",
    ]);
    expect(
      plan.destinations.every((item) => item.directories.includes(shared)),
    ).toBe(true);
    expect((await mod.executeBatch(plan, true)).status).toBe("succeeded");
    expect(requests.filter((path) => path === shared)).toHaveLength(1);
  });

  it.each([false, true])(
    "refreshes all selected aliases after an earlier link (secondary alias blocked: %s)",
    async (denyAlias) => {
      const f = await fixture();
      // Equivalent spelling with a repeated separator, preserving the real final component.
      const alias =
        dirname(f.destination) + sep + sep + basename(f.destination);
      const scan = async () => {
        const snapshot = await f.scan();
        const installations = snapshot.installations.map((item) =>
          item.id !== f.installation.id
            ? item
            : {
                ...item,
                agentDestinations: item.agentDestinations!.flatMap(
                  (destination) =>
                    destination.path !== f.destination
                      ? [destination]
                      : [
                          { path: f.destination, agents: ["antigravity"] },
                          { path: alias, agents: ["antigravity-cli"] },
                        ],
                ),
              },
        );
        return { ...snapshot, installations };
      };
      let links = 0;
      const mod = createAddAgentModule({
        scan,
        inspectGit: (path, creatingDirectory) =>
          denyAlias && links > 0 && path === alias
            ? Promise.resolve({ kind: "protected", worktreeRoot: f.home })
            : inspectGitProtection(
                path,
                false,
                systemCommandRunner,
                creatingDirectory,
              ),
        fileSystem: {
          ...nodeArtifactFileSystem,
          async symlink(source, destination, type) {
            await nodeArtifactFileSystem.symlink(source, destination, type);
            links++;
          },
        },
      });
      const inventory = await scan();
      const installation = inventory.installations.find(
        (item) => item.id === f.installation.id,
      )!;
      const plan = await mod.previewBatch(inventory, installation, [
        "aider-desk",
        "antigravity-cli",
        "antigravity",
      ]);
      expect(plan.block).toBeNull();
      expect(plan.destinations.map((item) => item.agents)).toEqual([
        ["aider-desk"],
        ["antigravity", "antigravity-cli"],
      ]);
      const report = await mod.executeBatch(plan, true);
      expect(report).toMatchObject({
        status: denyAlias ? "partial" : "succeeded",
        results: [
          { status: "added" },
          {
            agents: ["antigravity", "antigravity-cli"],
            status: denyAlias ? "blocked" : "added",
          },
        ],
      });
      expect(links).toBe(denyAlias ? 1 : 2);
      if (denyAlias)
        await expect(lstat(f.destination)).rejects.toMatchObject({
          code: "ENOENT",
        });
      else expect(await realpath(f.destination)).toBe(f.source);
    },
  );

  describe.each(["system", "plugin", "installation"] as const)(
    "protects an independent %s boundary",
    (kind) => {
      it.each([
        "inside-source",
        "around-source",
        "inside-destination",
        "around-destination",
      ] as const)("blocks %s and preserves its content", async (relation) => {
        const f = await fixture();
        const protectedPath =
          relation === "inside-source"
            ? join(f.source, "child")
            : relation === "around-source"
              ? dirname(f.source)
              : relation === "inside-destination"
                ? join(f.destination, "child")
                : dirname(f.destination);
        await mkdir(protectedPath, { recursive: true });
        const sentinel = join(protectedPath, "untouched.txt");
        await writeFile(sentinel, "user content");
        const location = {
          path: protectedPath,
          canonicalPath: protectedPath,
          artifactType: { kind: "directory" as const },
        };
        const scan = async () => {
          const snapshot = await f.scan();
          if (kind === "system")
            return {
              ...snapshot,
              otherFindings: [
                ...snapshot.otherFindings,
                buildSystemSkillFinding({ location }),
              ],
            };
          if (kind === "plugin")
            return {
              ...snapshot,
              plugins: [
                ...snapshot.plugins,
                buildPluginBoundary({
                  resources: [
                    {
                      kind: "other",
                      id: "plugin-content",
                      location,
                      protection: f.installation.protection,
                      cleanupId: null,
                    },
                  ],
                }),
              ],
            };
          return {
            ...snapshot,
            installations: [
              ...snapshot.installations,
              buildInstallation({
                id: "unrelated",
                location,
                identity: {
                  strongEvidence: [
                    {
                      kind: "canonical-target",
                      strength: "strong",
                      canonicalPath: protectedPath,
                    },
                  ],
                  weakEvidence: [],
                },
              }),
            ],
          };
        };
        const inventory = await scan();
        const selected = inventory.installations.find(
          (item) => item.id === f.installation.id,
        )!;
        const mod = createAddAgentModule({
          scan,
          inspectGit: (path) =>
            inspectGitProtection(path, false, systemCommandRunner),
          fileSystem: nodeArtifactFileSystem,
        });
        const plan = await mod.preview(inventory, selected, "antigravity-cli");
        expect(plan).toMatchObject({
          action: "blocked",
          reason: expect.stringContaining("ownership boundary"),
        });
        expect((await mod.execute(plan, true)).status).toBe("blocked");
        expect(await readFile(sentinel, "utf8")).toBe("user content");
        if (relation !== "inside-destination")
          await expect(lstat(f.destination)).rejects.toMatchObject({
            code: "ENOENT",
          });
      });
    },
  );

  it("requires a new visible confirmation after resizing the agent review", async () => {
    const f = await fixture();
    const executeBatch = vi.fn(f.addAgent.executeBatch);
    const controller = controllerFor({
      ...f,
      addAgent: { ...f.addAgent, executeBatch },
    });
    await controller.start();
    await controller.dispatch({ kind: "add-agent" });
    await controller.dispatch({ kind: "append-query", value: "agy" });
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "select" });
    const review = controller.state;
    if (review.screen !== "add-agent" || review.stage !== "review")
      throw new Error("Expected agent review");
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 7, columns: 40 },
    });
    await controller.dispatch(
      parseRawTuiAction(controller.state, "y", {
        name: "y",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    );
    await controller.dispatch({ kind: "confirm" });
    await controller.waitForAddAgentExecution();
    expect(executeBatch).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({
      stage: "review",
      plan: review.plan,
    });
    await expect(lstat(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 20, columns: 80 },
    });
    await controller.waitForAddAgentExecution();
    expect(executeBatch).not.toHaveBeenCalled();
    await controller.dispatch({ kind: "confirm" });
    await controller.waitForAddAgentExecution();
    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(await realpath(f.destination)).toBe(f.source);
  });

  it("ignores pointer input at the resize prompt and accepts a click after the picker appears", async () => {
    const f = await fixture();
    const controller = controllerFor(f);
    await controller.start();
    await controller.dispatch({ kind: "add-agent" });
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 7, columns: 80 },
    });
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "Resize the terminal",
    );
    for (let row = 1; row <= 7; row++) {
      const click = { pressed: true, button: 0, column: 40, row };
      for (const button of [0, 64])
        expect(
          mouseAction(
            controller.state,
            { ...click, button },
            { dragging: false, doubleClick: false },
          ),
        ).toEqual({ kind: "noop" });
    }
    const hidden = controller.state;
    for (const action of [
      { kind: "append-query", value: "agy" },
      { kind: "toggle-select" },
      { kind: "point-agent", index: 1 },
      { kind: "select" },
    ] as const)
      await controller.dispatch(action);
    expect(controller.state).toBe(hidden);
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 8, columns: 80 },
    });
    const lines = renderTui(controller.state, plainTuiTheme).split("\n");
    const index = lines.findIndex((line) => line.includes("│[ ]"));
    expect(index).toBeGreaterThan(0);
    const click = {
      pressed: true,
      button: 0,
      column: lines[index]!.indexOf("[ ]") + 1,
      row: index + 1,
    };
    expect(
      mouseAction(controller.state, click, {
        dragging: false,
        doubleClick: false,
      }),
    ).toEqual({ kind: "point-agent", index: 0 });
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
    if (
      controller.state.screen !== "add-agent" ||
      controller.state.stage !== "selection"
    )
      throw new Error("Expected agent picker");
    expect(controller.state.picker.agents).not.toContain("claude-code");
    expect(controller.state.picker.agents).not.toContain("codex");
    expect(controller.state.picker.agents).not.toContain("antigravity-cli");
    expect(controller.state.picker.agents).not.toContain("antigravity");
    expect(controller.state.picker.agents).toContain("qwen-code");
    expect(controller.state.picker.agents).toContain("augment");
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
    expect(controller.state).toMatchObject({ stage: "selection" });
    expect(controller.state).not.toHaveProperty("plan");
    await controller.dispatch({ kind: "clear-query" });
    await controller.dispatch({ kind: "append-query", value: "misspelled" });
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "No matching agents",
    );
    await controller.dispatch({ kind: "clear-query" });
    await controller.dispatch({ kind: "append-query", value: "qwen" });
    await controller.dispatch({ kind: "select" });
    expect(controller.state).toMatchObject({
      stage: "review",
      plan: { destinations: [{ action: "blocked" }] },
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
    expect(controller.state).toMatchObject({
      screen: "add-agent",
      stage: "selection",
      picker: { agents: [] },
    });
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
    expect(controller.state).toMatchObject({ stage: "selection" });
    expect(controller.state).not.toHaveProperty("plan");
  });
  it.each([22, 28])(
    "keeps the search, review, result and their controls visible at %i by 8",
    async (columns) => {
      const f = await fixture();
      const report = {
        status: "failed" as const,
        message: "Write failed",
        results: [
          {
            destination: f.destination,
            agents: ["antigravity-cli"],
            status: "failed" as const,
            message: "Fixture failure",
          },
        ],
      };
      const executeBatch = vi.fn(async () => report);
      const controller = controllerFor({
        ...f,
        addAgent: { ...f.addAgent, executeBatch },
      });
      await controller.start();
      await controller.dispatch({ kind: "add-agent" });
      await controller.dispatch({ kind: "append-query", value: "agy" });
      await controller.dispatch({ kind: "toggle-select" });
      await controller.dispatch({ kind: "select" });
      await controller.dispatch({
        kind: "viewport",
        viewport: { columns, rows: 8 },
      });
      const frame = () =>
        renderTui(controller.state, plainTuiTheme).trimEnd().split("\n");
      expect(frame()[0]!.startsWith("Review agents")).toBe(true);
      expect(frame().at(-1)).toContain("y confirm · esc back");
      await controller.dispatch({ kind: "page", delta: 1 });
      expect(controller.state).toMatchObject({
        stage: "review",
        scrollOffset: expect.any(Number),
      });
      await controller.dispatch({ kind: "cancel" });
      expect(frame()[0]).toContain("1 selected");
      expect(frame()[1]).toContain("space · enter · esc");
      expect(frame().join("\n")).toContain("[x] antigravity-cli");
      await controller.dispatch({ kind: "select" });
      await controller.dispatch({ kind: "confirm" });
      await controller.waitForAddAgentExecution();
      expect(frame()[0]!.startsWith("Add agent results")).toBe(true);
      expect(frame().at(-1)).toContain("esc inventory");
      await controller.dispatch({ kind: "page", delta: 100 });
      expect(frame().join("\n")).toContain("Fixture failure");
      await controller.dispatch({ kind: "cancel" });
      expect(controller.state).toMatchObject({
        screen: "browse",
        model: { viewport: { columns, rows: 8 } },
      });
    },
  );

  it("shares the search results viewport, page navigation and mouse targets", async () => {
    const f = await fixture();
    const controller = controllerFor(f);
    const viewport = { rows: 15, columns: 118 };
    await controller.start();
    await controller.dispatch({ kind: "viewport", viewport });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "toggle-select" });
    const before = controller.state;
    await controller.dispatch({ kind: "add-agent" });
    const grid = searchLayout(viewport);
    const click = async (column: number, row: number, doubleClick = false) =>
      controller.dispatch(
        mouseAction(
          controller.state,
          { button: 0, column, row, pressed: true },
          { dragging: false, doubleClick },
        ),
      );
    await click(8, grid.resultStartRow + 1);
    expect(controller.state).toMatchObject({
      screen: "add-agent",
      stage: "selection",
      picker: { index: 1, selectedAgents: new Set() },
    });
    await click(8, grid.resultStartRow + 1, true);
    const checked = controller.state;
    if (checked.screen !== "add-agent" || checked.stage !== "selection")
      throw new Error("Missing agent list");
    const agent = checked.picker.agents[1]!;
    expect(checked.picker.selectedAgents).toEqual(new Set([agent]));
    const lines = renderTui(checked, plainTuiTheme).split("\n");
    expect(lines[grid.resultStartRow]).toContain("[x] " + agent);
    expect(lines[grid.resultStartRow - 1]!.slice(grid.leftWidth + 2)).toContain(
      agent,
    );
    await click(grid.leftWidth + 4, grid.resultStartRow);
    expect(controller.state).toEqual(checked);
    await controller.dispatch({ kind: "page", delta: 1 });
    expect(controller.state).toMatchObject({
      picker: { index: grid.resultRows + 1 },
    });
    await controller.dispatch({ kind: "cancel" });
    expect(controller.state).toEqual(before);
  });

  it.each([8, 9, 15, 24])(
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
      expect(frame().split("\n")[0]).toContain("Add agents · review");
      expect(frame()).toContain("0 selected");
      const searchRow = frame()
        .split("\n")
        .findIndex((line) => line.includes("> type an agent name"));
      const grid = searchLayout({ rows, columns: 80 });
      expect(frame().split("\n")[0]).toContain("0 selected");
      expect(frame().split("\n")[grid.resultStartRow - 1]).toContain("[ ]");
      for (const char of "agy") await press(char);
      expect(frame()).toContain("antigravity-cli");
      expect(frame()).toContain("1 match");
      expect(frame()).not.toContain("1 matches");
      expect(frame().split("\n")[grid.resultStartRow - 1]).toContain(
        "antigravity-cli (agy)",
      );
      const lines = frame().split("\n");
      expect(lines.findIndex((line) => line.includes("> agy"))).toBe(searchRow);
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
      expect(controller.state).toMatchObject({
        stage: "selection",
        picker: { query: "", selectedAgents: new Set(["antigravity-cli"]) },
      });
      expect(frame().split("\n")[0]).toContain("1 selected");
      for (const char of "claude") await press(char);
      await press(" ", "space");
      expect(frame()).toContain("2 selected");
      for (let i = 0; i < 6; i++) await press("", "backspace");
      await press("q");
      expect(controller.state).toMatchObject({
        screen: "add-agent",
        stage: "selection",
        picker: { query: "q" },
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
      if (picker.screen !== "add-agent" || picker.stage !== "selection")
        throw new Error("No agent picker");
      await controller.dispatch({
        kind: "move",
        delta: picker.picker.agents.indexOf("antigravity-cli"),
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
        inventory: {
          installations: [
            expect.objectContaining({
              id: f.installation.id,
              exposedTo: expect.arrayContaining(["antigravity-cli"]),
            }),
          ],
        },
      });
      expect(await realpath(f.destination)).toBe(f.source);
    },
  );
});

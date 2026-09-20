import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionSetupScanner,
  type InventoryCommandRunner,
} from "../src/index.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("Codex Session setup Inventory", () => {
  it("uses installed owner evidence and projects standalone, Plugin, MCP, and shared App policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const pluginRoot = join(
      codex,
      "plugins",
      "cache",
      "market",
      "bundle",
      "1.0.0",
    );
    await skill(join(codex, "skills", "standalone"), "standalone");
    await write(
      join(codex, "config.toml"),
      '[mcp_servers.local]\ncommand = "local"\nenabled = true\n\n[apps.connector]\nenabled = false\n',
    );
    await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
      name: "bundle",
      version: "1.0.0",
      mcpServers: { package: { command: "package" } },
      apps: "./.app.json",
    });
    await writeJson(join(pluginRoot, ".app.json"), {
      apps: {
        left: { id: "connector" },
        right: { id: "connector" },
      },
    });
    const runner: InventoryCommandRunner = {
      run: async (command) =>
        command.executable === "codex"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                installed: [
                  {
                    pluginId: "bundle@market",
                    name: "bundle",
                    marketplaceName: "market",
                    version: "1.0.0",
                    installed: true,
                    enabled: true,
                    source: {
                      source: "git",
                      url: "https://example.test/bundle",
                    },
                    installPolicy: "AVAILABLE",
                    authPolicy: "ON_USE",
                  },
                ],
                available: [],
              }),
            }
          : { exitCode: 1, stdout: "" },
    };
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: runner,
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
      roots: [
        {
          kind: "agent",
          path: join(codex, "skills"),
          agentId: "codex",
          adapterId: null,
        },
      ],
    });
    expect(snapshot.targets.map((target) => target.kind).sort()).toEqual([
      "app-binding",
      "app-binding",
      "mcp-registration",
      "mcp-registration",
      "plugin",
      "skill-exposure",
    ]);
    expect(
      snapshot.targets
        .filter((target) => target.kind === "app-binding")
        .every(
          (target) => target.control.selector.governedTargetIds.length === 2,
        ),
    ).toBe(true);
    expect(
      snapshot.targets.find((target) => target.kind === "plugin")?.owner,
    ).toEqual(expect.objectContaining({ kind: "plugin" }));
    expect(
      snapshot.sources.filter((source) =>
        source.source.sourceId.includes("plugin-descriptor"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "app-binding",
          status: "success",
          reason: null,
          source: expect.objectContaining({
            path: join(pluginRoot, ".app.json"),
          }),
        }),
      ]),
    );
  });
});

async function write(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await write(path, `${JSON.stringify(value)}\n`);
}
async function skill(path: string, name: string): Promise<void> {
  await write(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}

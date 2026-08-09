import {
  link,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createInventoryScanner,
  parseInstallation,
  type DiscoveryRoot,
  type InventoryCommand,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const fixture = createIsolatedTestEnvironmentFixture();
const noCommands: InventoryCommandRunner = {
  async run() {
    return { exitCode: 1, stdout: "" };
  },
};

async function skill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\n---\n# ${name}\n`,
  );
}

function scanner(
  environment: InventoryScanEnvironment,
  roots: readonly DiscoveryRoot[],
) {
  return createInventoryScanner({
    now: () => new Date("2026-02-03T04:05:06.000Z"),
    environment,
    commandRunner: noCommands,
  }).scan({ roots });
}

describe("native availability evidence", () => {
  it("uses Codex ordered path and name rules without turning a name into identity", async () => {
    const environment = await fixture();
    const codexHome = join(environment.home, ".codex");
    const root = join(environment.temporary, "codex-skills");
    const path = join(root, "review");
    await skill(path, "review");
    const selector = await realpath(join(path, "SKILL.md"));
    const selectorAlias = join(root, "review-alias.md");
    await symlink(selector, selectorAlias);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'title = "ordinary Codex configuration"',
        "[terminal]",
        'instructions = """',
        "A valid unrelated multiline value must not affect skill controls.",
        '"""',
        "[skills]",
        "bundled = { enabled = true }",
        "include_instructions = false",
        "[[skills.config]]",
        'name = " review "',
        "enabled = false",
        "[[skills.config]]",
        `path = ${JSON.stringify(selectorAlias)}`,
        "enabled = true",
        "[[skills.config]]",
        'name = " review "',
        "enabled = false",
        "",
      ].join("\n"),
    );
    const inventory = await scanner(
      {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
        agentHomeDirectories: { codex: codexHome },
      },
      [{ kind: "user", path: root, agentId: "codex", adapterId: null }],
    );
    const exposure = inventory.installations[0]!.harnessExposures[0]!;
    expect(exposure).toMatchObject({
      harnessId: "codex",
      status: "disabled",
      control: {
        kind: "native",
        selector: { kind: "path", value: selector },
      },
    });
    const layer = (
      exposure.control as Extract<typeof exposure.control, { kind: "native" }>
    ).layers[0]!;
    expect(layer.selectorValue).toEqual({
      kind: "codex-skills-config",
      matchingRules: [
        {
          index: 0,
          selector: { kind: "name", value: "review" },
          enabled: false,
        },
        {
          index: 1,
          selector: { kind: "path", value: selector },
          enabled: true,
        },
        {
          index: 2,
          selector: { kind: "name", value: "review" },
          enabled: false,
        },
      ],
    });
    expect(layer.preimageHash).toMatchObject({ algorithm: "sha256" });
    expect(layer.documentScope).toBe("user");
    expect(layer.applies).toBe(true);
    expect(() =>
      parseInstallation({
        ...inventory.installations[0]!,
        harnessExposures: [
          {
            ...exposure,
            control: {
              ...(exposure.control as Extract<
                typeof exposure.control,
                { kind: "native" }
              >),
              selector: { kind: "name", value: "review" },
            },
          },
        ],
      }),
    ).toThrow(/Codex native evidence/);
  });

  it("applies Claude Code user, shared, and local precedence while preserving its mode", async () => {
    const environment = await fixture();
    const claudeHome = join(environment.home, ".claude");
    const root = join(environment.temporary, "claude-skills");
    await skill(join(root, "review"), "review");
    await mkdir(join(environment.workspace, ".claude"), { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      join(claudeHome, "settings.json"),
      '{"skillOverrides":{"review":"off"}}',
    );
    await writeFile(
      join(environment.workspace, ".claude", "settings.json"),
      '{"skillOverrides":{"review":"on"}}',
    );
    await writeFile(
      join(environment.workspace, ".claude", "settings.local.json"),
      '{"skillOverrides":{"review":"user-invocable-only"}}',
    );
    const inventory = await scanner(
      {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
        agentHomeDirectories: { "claude-code": claudeHome },
      },
      [{ kind: "user", path: root, agentId: "claude-code", adapterId: null }],
    );
    const exposure = inventory.installations[0]!.harnessExposures[0]!;
    expect(exposure.status).toBe("enabled");
    const control = exposure.control as Extract<
      typeof exposure.control,
      { kind: "native" }
    >;
    expect(control.layers.map((layer) => layer.selectorValue)).toEqual([
      { kind: "claude-skill-overrides", mode: "off" },
      { kind: "claude-skill-overrides", mode: "on" },
      { kind: "claude-skill-overrides", mode: "user-invocable-only" },
    ]);
    expect(control.writableLayerPaths).toEqual([
      join(claudeHome, "settings.json"),
      join(environment.workspace, ".claude", "settings.local.json"),
    ]);
    expect(control.layers.map((layer) => layer.documentScope)).toEqual([
      "user",
      "shared-workspace",
      "local-workspace",
    ]);
    expect(control.availability.disable).toEqual({ kind: "available" });
  });

  it("uses Gemini JSONC union with exact case-sensitive names", async () => {
    const environment = await fixture();
    const geminiHome = join(environment.home, ".gemini");
    const root = join(environment.temporary, "gemini-skills");
    await skill(join(root, "review"), "Review");
    await mkdir(geminiHome, { recursive: true });
    await writeFile(
      join(geminiHome, "settings.json"),
      '{ // comment\n "skills": { "disabled": ["Review",], }, }',
    );
    const inventory = await scanner(
      {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
        agentHomeDirectories: { "gemini-cli": geminiHome },
      },
      [{ kind: "user", path: root, agentId: "gemini-cli", adapterId: null }],
    );
    const exposure = inventory.installations[0]!.harnessExposures[0]!;
    expect(exposure.status).toBe("disabled");
    const control = exposure.control as Extract<
      typeof exposure.control,
      { kind: "native" }
    >;
    expect(control.layers[0]!.selectorValue).toEqual({
      kind: "gemini-disabled-skills",
      disabled: true,
    });
    expect(control.layers[1]!.selectorValue).toEqual({
      kind: "gemini-disabled-skills",
      disabled: false,
    });
    expect(control.layers.map((layer) => layer.applies)).toEqual([
      true,
      "unresolved",
    ]);
    expect(control.availability).toEqual({
      disable: { kind: "available" },
      enable: { kind: "available" },
    });
  });

  it("fails closed when an unproven Gemini workspace layer disables the Skill", async () => {
    const environment = await fixture();
    const root = join(environment.temporary, "gemini-trust-skills");
    await skill(join(root, "review"), "review");
    await mkdir(join(environment.workspace, ".gemini"), { recursive: true });
    await writeFile(
      join(environment.workspace, ".gemini", "settings.json"),
      '{"skills":{"disabled":["review"]}}',
    );
    const inventory = await scanner(
      {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      [{ kind: "user", path: root, agentId: "gemini-cli", adapterId: null }],
    );
    const exposure = inventory.installations[0]!.harnessExposures[0]!;
    expect(exposure.status).toBe("unresolved");
    expect(
      (exposure.control as Extract<typeof exposure.control, { kind: "native" }>)
        .availability,
    ).toMatchObject({
      disable: { kind: "unavailable" },
      enable: { kind: "unavailable" },
    });
  });

  it("includes canonical availability evidence in the semantic inventory fingerprint", async () => {
    const environment = await fixture();
    const geminiHome = join(environment.home, ".gemini");
    const root = join(environment.temporary, "fingerprint-skills");
    await skill(join(root, "review"), "review");
    await mkdir(geminiHome, { recursive: true });
    const settings = join(geminiHome, "settings.json");
    await writeFile(settings, '{"skills":{"disabled":[]}}');
    const scanInput = {
      homeDirectory: environment.home,
      workspaceDirectory: environment.workspace,
      agentHomeDirectories: { "gemini-cli": geminiHome },
    };
    const roots: readonly DiscoveryRoot[] = [
      { kind: "user", path: root, agentId: "gemini-cli", adapterId: null },
    ];
    const enabled = await scanner(scanInput, roots);
    await writeFile(settings, '{"skills":{"disabled":["review"]}}');
    const disabled = await scanner(scanInput, roots);
    expect(enabled.id).not.toBe(disabled.id);
    expect(disabled.installations[0]!.harnessExposures[0]!.status).toBe(
      "disabled",
    );
  });

  it("snapshots a shared native configuration once for every exposed Skill", async () => {
    const environment = await fixture();
    const codexHome = join(environment.home, ".codex");
    const root = join(environment.temporary, "shared-codex-skills");
    await skill(join(root, "one"), "one");
    await skill(join(root, "two"), "two");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      "[skills]\nbundled = { enabled = true }\n",
    );
    let configProbeCount = 0;
    const runner: InventoryCommandRunner = {
      async run(command) {
        if (
          command.executable === "git" &&
          command.arguments[0] === "-C" &&
          command.arguments[1] === codexHome
        )
          configProbeCount += 1;
        return { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date("2026-02-03T04:05:06.000Z"),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
        agentHomeDirectories: { codex: codexHome },
      },
      commandRunner: runner,
    }).scan({
      roots: [{ kind: "user", path: root, agentId: "codex", adapterId: null }],
    });
    const hashes = inventory.installations.map(
      (installation) =>
        (
          installation.harnessExposures[0]!.control as Extract<
            (typeof installation.harnessExposures)[number]["control"],
            { kind: "native" }
          >
        ).layers[0]!.preimageHash,
    );
    expect(configProbeCount).toBe(1);
    expect(hashes[0]).toEqual(hashes[1]);
  });

  it("leaves plugin-owned exposures visible but unsupported", async () => {
    const environment = await fixture();
    const root = join(environment.temporary, "plugin-skills");
    await skill(join(root, "review"), "review");
    const inventory = await scanner(
      {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      [
        {
          kind: "plugin",
          path: root,
          agentId: "codex",
          adapterId: null,
          scope: { kind: "user" },
          plugin: { id: "fixture-plugin", version: "1.0.0" },
          independentlySelectable: false,
        },
      ],
    );
    expect(inventory.installations[0]!.harnessExposures).toEqual([
      {
        harnessId: "codex",
        status: "enabled",
        control: {
          kind: "unsupported",
          reason:
            "this harness exposure has no supported native availability control",
        },
      },
    ]);
  });

  it("keeps Claude local overrides safe and requires every applied Gemini membership for enable", async () => {
    const environment = await fixture();
    const workspace = environment.workspace;
    const runner: InventoryCommandRunner = {
      async run(command: InventoryCommand) {
        if (command.executable !== "git") return { exitCode: 1, stdout: "" };
        if (command.arguments.includes("rev-parse")) {
          return command.arguments[1]?.startsWith(workspace)
            ? { exitCode: 0, stdout: `${workspace}\n` }
            : { exitCode: 1, stdout: "" };
        }
        const candidate = command.arguments.at(-1);
        return {
          exitCode: candidate === ".claude/settings.local.json" ? 0 : 1,
          stdout: "",
        };
      },
    };

    const claudeHome = join(environment.home, ".claude");
    const claudeRoot = join(environment.temporary, "claude-override-skills");
    await skill(join(claudeRoot, "review"), "review");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      join(workspace, ".claude", "settings.json"),
      '{"skillOverrides":{"review":"off"}}',
    );
    await writeFile(
      join(workspace, ".claude", "settings.local.json"),
      '{"skillOverrides":{"review":"on"}}',
    );
    const claude = await createInventoryScanner({
      now: () => new Date("2026-02-03T04:05:06.000Z"),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { "claude-code": claudeHome },
      },
      commandRunner: runner,
    }).scan({
      roots: [
        {
          kind: "user",
          path: claudeRoot,
          agentId: "claude-code",
          adapterId: null,
        },
      ],
    });
    expect(
      (
        claude.installations[0]!.harnessExposures[0]!.control as Extract<
          (typeof claude.installations)[number]["harnessExposures"][number]["control"],
          { kind: "native" }
        >
      ).availability,
    ).toEqual({
      disable: { kind: "available" },
      enable: { kind: "available" },
    });

    const geminiHome = join(environment.home, ".gemini");
    const geminiRoot = join(environment.temporary, "gemini-enable-skills");
    await skill(join(geminiRoot, "review"), "review");
    await mkdir(join(workspace, ".gemini"), { recursive: true });
    await mkdir(geminiHome, { recursive: true });
    await writeFile(
      join(geminiHome, "settings.json"),
      '{"skills":{"disabled":["review"]}}',
    );
    await writeFile(
      join(workspace, ".gemini", "settings.json"),
      '{"skills":{"disabled":["review"]}}',
    );
    const gemini = await createInventoryScanner({
      now: () => new Date("2026-02-03T04:05:06.000Z"),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { "gemini-cli": geminiHome },
        geminiWorkspaceTrusted: true,
      },
      commandRunner: runner,
    }).scan({
      roots: [
        {
          kind: "user",
          path: geminiRoot,
          agentId: "gemini-cli",
          adapterId: null,
        },
      ],
    });
    expect(
      (
        gemini.installations[0]!.harnessExposures[0]!.control as Extract<
          (typeof gemini.installations)[number]["harnessExposures"][number]["control"],
          { kind: "native" }
        >
      ).availability,
    ).toEqual({
      disable: { kind: "available" },
      enable: {
        kind: "unavailable",
        reason:
          "every applied Gemini disabled-name membership must be writable to enable the Skill",
      },
    });
  });

  it("fails closed for malformed, duplicate, linked, and hard-linked control documents without writing one", async () => {
    const environment = await fixture();
    const claudeHome = join(environment.home, ".claude");
    const root = join(environment.temporary, "claude-skills");
    await skill(join(root, "review"), "review");
    await mkdir(claudeHome, { recursive: true });
    const settings = join(claudeHome, "settings.json");
    const scanInput = {
      homeDirectory: environment.home,
      workspaceDirectory: environment.workspace,
      agentHomeDirectories: { "claude-code": claudeHome },
    };
    const roots: readonly DiscoveryRoot[] = [
      { kind: "user", path: root, agentId: "claude-code", adapterId: null },
    ];
    await writeFile(settings, '{"skillOverrides":');
    let inventory = await scanner(scanInput, roots);
    expect(inventory.installations[0]!.harnessExposures[0]!.status).toBe(
      "unresolved",
    );

    await writeFile(
      settings,
      '{"skillOverrides":{"review":"on","review":"off"}}',
    );
    const before = await readFile(settings, "utf8");
    inventory = await scanner(scanInput, roots);
    expect(inventory.installations[0]!.harnessExposures[0]!.status).toBe(
      "unresolved",
    );
    expect(await readFile(settings, "utf8")).toBe(before);

    const linked = join(claudeHome, "linked-settings.json");
    await writeFile(linked, '{"skillOverrides":{"review":"off"}}');
    await unlink(settings);
    await symlink(linked, settings);
    inventory = await scanner(scanInput, roots);
    expect(
      inventory.installations[0]!.harnessExposures[0]!.control,
    ).toMatchObject({
      kind: "native",
      availability: { disable: { kind: "unavailable" } },
    });

    await unlink(settings);
    await link(linked, settings);
    inventory = await scanner(scanInput, roots);
    expect(inventory.installations[0]!.harnessExposures[0]!.status).toBe(
      "unresolved",
    );
  });
});

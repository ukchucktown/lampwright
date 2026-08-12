import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createExecutionModule,
  plan,
  planAvailability,
  type NativeControlDocumentEvidence,
  type Inventory,
  type PluginBoundary,
  type ProtectionStatus,
} from "../src/index.js";
import { buildInventory, buildPluginBoundary } from "../src/testing/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const environmentFixture = createIsolatedTestEnvironmentFixture();
const protection: ProtectionStatus = {
  git: { kind: "outside-worktree" },
  system: { kind: "none" },
  filesystem: { kind: "writable" },
};
const readOnlyProtection: ProtectionStatus = {
  ...protection,
  filesystem: { kind: "read-only", reason: "fixture layer is read-only" },
};

function hash(text: string) {
  return {
    algorithm: "sha256" as const,
    digest: createHash("sha256").update(text).digest("hex"),
  };
}

function layer(
  path: string,
  text: string | null,
  documentScope: NativeControlDocumentEvidence["documentScope"],
  selectorValue: NativeControlDocumentEvidence["selectorValue"],
  layerProtection: ProtectionStatus = protection,
): NativeControlDocumentEvidence {
  return {
    path,
    format:
      documentScope === "user" && path.endsWith(".toml") ? "toml" : "json",
    scope:
      documentScope === "user"
        ? { kind: "user" }
        : { kind: "workspace", workspacePath: dirname(dirname(path)) },
    documentScope,
    applies: true,
    exists: text !== null,
    canonicalPath: text === null ? null : path,
    preimageHash: text === null ? null : hash(text),
    protection: layerProtection,
    selectorValue,
  };
}

async function fixture(
  mechanism:
    | "codex-plugin-enabled"
    | "claude-enabled-plugins"
    | "gemini-extension-enablement",
) {
  const environment = await environmentFixture();
  const workspace = join(environment.home, "workspace");
  await mkdir(workspace, { recursive: true });
  const pluginId =
    mechanism === "gemini-extension-enablement"
      ? "quality-suite"
      : "quality-suite@acme";
  const harness =
    mechanism === "codex-plugin-enabled"
      ? "codex"
      : mechanism === "claude-enabled-plugins"
        ? "claude-code"
        : "gemini-cli";
  const config =
    mechanism === "codex-plugin-enabled"
      ? join(environment.home, ".codex", "config.toml")
      : mechanism === "claude-enabled-plugins"
        ? join(environment.home, ".claude", "settings.json")
        : join(
            environment.home,
            ".gemini",
            "extensions",
            "extension-enablement.json",
          );
  const initial =
    mechanism === "codex-plugin-enabled"
      ? `# keep\r\n[plugins.${JSON.stringify(pluginId)}]\r\nenabled = true\r\n`
      : mechanism === "claude-enabled-plugins"
        ? '{\n  "unrelated": true,\n  "enabledPlugins": {}\n}\n'
        : '{\n  "unrelated": true\n}\n';
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, initial);

  const scan = async () => {
    const text = await readFile(config, "utf8");
    let status: "enabled" | "disabled" = "enabled";
    let layers: NativeControlDocumentEvidence[];
    if (mechanism === "codex-plugin-enabled") {
      const enabled = /enabled\s*=\s*false/u.test(text) ? false : true;
      status = enabled ? "enabled" : "disabled";
      layers = [
        layer(config, text, "user", {
          kind: mechanism,
          enabled,
        }),
      ];
    } else if (mechanism === "claude-enabled-plugins") {
      const value = JSON.parse(text) as {
        enabledPlugins?: Record<string, boolean>;
      };
      const enabled = value.enabledPlugins?.[pluginId] ?? null;
      status = enabled === false ? "disabled" : "enabled";
      const shared = join(workspace, ".claude", "settings.json");
      const local = join(workspace, ".claude", "settings.local.json");
      layers = [
        layer(config, text, "user", { kind: mechanism, enabled }),
        layer(
          shared,
          null,
          "shared-workspace",
          { kind: mechanism, enabled: null },
          readOnlyProtection,
        ),
        layer(
          local,
          null,
          "local-workspace",
          { kind: mechanism, enabled: null },
          readOnlyProtection,
        ),
      ];
    } else {
      const value = JSON.parse(text) as Record<
        string,
        { overrides?: string[] }
      >;
      const overrides = value[pluginId]?.overrides ?? [];
      status = overrides.at(-1)?.startsWith("!") ? "disabled" : "enabled";
      layers = [
        layer(config, text, "user", {
          kind: mechanism,
          overrides,
          enabled: status === "enabled",
          scopePath: environment.home,
        }),
      ];
    }
    const plugin = buildPluginBoundary({
      id: "quality-plugin-boundary",
      pluginId,
      adapterId: "fixture-adapter",
      exposedTo: [harness],
      ownership: {
        kind: "plugin",
        pluginId,
        independentlySelectable: false,
        confidence: "declared",
      },
      installationIds: [],
      availability: {
        status,
        control: {
          kind: "native",
          mechanism,
          availability: {
            disable: { kind: "available" },
            enable: { kind: "available" },
          },
          selector: { kind: "plugin-id", value: pluginId },
          layers,
          writableLayerPaths:
            mechanism === "claude-enabled-plugins"
              ? [layers[0]!.path, layers[2]!.path]
              : [layers[0]!.path],
        },
      },
    });
    return buildInventory({
      id: `inventory-${hash(text).digest.slice(0, 12)}`,
      installations: [],
      logicalSkills: [],
      plugins: [plugin],
    });
  };

  return { environment, config, mechanism, pluginId, scan };
}

function execution(scan: () => Promise<Inventory>) {
  return createExecutionModule({
    scan,
    replan: (inventory, intent) => plan(inventory, intent),
    quarantine: {
      async quarantine() {
        return { status: "already-absent", path: "/unused" };
      },
    } as never,
    processRunner: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    inspectGitProtection: async () => ({ kind: "outside-worktree" }),
    auditWriter: { async write() {} },
    packageTrustStore: {
      async isTrusted() {
        return false;
      },
      async trust() {},
    },
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    stateRoot: "/fixture-state",
    disabledStorage: {
      async list() {
        return [];
      },
      async suspend() {
        throw new Error("unexpected suspension");
      },
      async previewEnable() {
        throw new Error("unexpected storage preview");
      },
      async enable() {
        throw new Error("unexpected storage enable");
      },
    },
    replanAvailability: planAvailability,
    availabilityAuditWriter: { async write() {} },
  });
}

describe("whole-Plugin availability", () => {
  for (const mechanism of [
    "codex-plugin-enabled",
    "claude-enabled-plugins",
    "gemini-extension-enablement",
  ] as const) {
    it(`round-trips ${mechanism} without Plugin-owned Skill suspension`, async () => {
      const value = await fixture(mechanism);
      const initial = await value.scan();
      const target = {
        kind: "plugin" as const,
        pluginBoundaryId: initial.plugins[0]!.id,
      };
      const disable = planAvailability(initial, [], {
        operation: "disable",
        targets: [target],
        force: false,
      });
      expect(disable.blocks).toEqual([]);
      expect(disable.actions).toHaveLength(1);
      expect(disable.actions[0]).toMatchObject({
        kind: "native-control",
        affectedInstallationIds: [],
        effects: [{ pluginBoundaryId: target.pluginBoundaryId }],
      });
      const runner = execution(value.scan);
      const disabled = await runner.executeAvailability(disable, {
        grants: [{ kind: "confirmation" }],
      });
      expect(disabled.status).toBe("succeeded");
      expect((await value.scan()).plugins[0]!.availability.status).toBe(
        "disabled",
      );

      const disabledInventory = await value.scan();
      const enable = planAvailability(disabledInventory, [], {
        operation: "enable",
        targets: [target],
        force: false,
      });
      const enabled = await runner.executeAvailability(enable, {
        grants: [{ kind: "confirmation" }],
      });
      expect(enabled.status).toBe("succeeded");
      expect((await value.scan()).plugins[0]!.availability.status).toBe(
        "enabled",
      );
      const finalText = await readFile(value.config, "utf8");
      expect(finalText).toContain(
        mechanism === "codex-plugin-enabled" ? "keep" : "unrelated",
      );
      if (mechanism === "codex-plugin-enabled")
        expect(finalText).not.toMatch(/[^\r]\n/u);
    });
  }

  it("keeps runtime-default and unsupported Plugins blocked without actions", () => {
    for (const plugin of [
      buildPluginBoundary({ runtimeDefault: true }),
      buildPluginBoundary(),
    ] satisfies PluginBoundary[]) {
      const inventory = buildInventory({ plugins: [plugin] });
      const availabilityPlan = planAvailability(inventory, [], {
        operation: "disable",
        targets: [{ kind: "plugin", pluginBoundaryId: plugin.id }],
        force: true,
      });
      expect(availabilityPlan.actions).toEqual([]);
      expect(availabilityPlan.blocks.some((block) => !block.overridable)).toBe(
        true,
      );
    }
  });

  it("rejects a stale Plugin plan without overwriting the changed document", async () => {
    const value = await fixture("codex-plugin-enabled");
    const inventory = await value.scan();
    const target = {
      kind: "plugin" as const,
      pluginBoundaryId: inventory.plugins[0]!.id,
    };
    const planned = planAvailability(inventory, [], {
      operation: "disable",
      targets: [target],
      force: false,
    });
    const changed = `${await readFile(value.config, "utf8")}# external change\r\n`;
    await writeFile(value.config, changed);

    const report = await execution(value.scan).executeAvailability(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("blocked");
    expect(await readFile(value.config, "utf8")).toBe(changed);
  });

  it("fails closed when a valid inline Codex table cannot be safely edited", async () => {
    const value = await fixture("codex-plugin-enabled");
    const inline = `[plugins]\r\n${JSON.stringify(value.pluginId)} = { enabled = true }\r\n`;
    await writeFile(value.config, inline);
    const inventory = await value.scan();
    const planned = planAvailability(inventory, [], {
      operation: "disable",
      targets: [
        {
          kind: "plugin",
          pluginBoundaryId: inventory.plugins[0]!.id,
        },
      ],
      force: false,
    });

    const report = await execution(value.scan).executeAvailability(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("failed");
    expect(await readFile(value.config, "utf8")).toBe(inline);
  });
});

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, toNamespacedPath, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdapterLoadError,
  AdapterTrustRequiredError,
  loadAdapters,
  type AdapterDefinitionV1,
  type AdapterDefinitionV2,
  type AdapterPathBases,
  type AdapterPlatform,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();

function fixturePathBases(environment: {
  readonly home: string;
  readonly workspace: string;
  readonly config: string;
  readonly state: string;
  readonly cache: string;
  readonly temporary: string;
}): AdapterPathBases {
  return {
    home: environment.home,
    workspace: environment.workspace,
    config: environment.config,
    state: environment.state,
    cache: environment.cache,
    temporary: environment.temporary,
  };
}

function supportedPlatform(): AdapterPlatform {
  if (
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
  ) {
    return process.platform;
  }
  throw new Error(`unsupported test platform: ${process.platform}`);
}

function readOnlyDefinition(): AdapterDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "fixture.read-only",
    name: "Fixture read-only adapter",
    platforms: ["win32", "linux", "darwin"],
    probes: [
      {
        id: "manager-present",
        kind: "executable",
        executable: { default: "fixture-manager" },
      },
    ],
    roots: [
      {
        id: "skills-root",
        kind: "user",
        path: {
          default: {
            base: "home",
            segments: [".fixture-agent", "skills"],
          },
        },
        requiresProbes: ["manager-present"],
        agentId: "fixture-agent",
      },
    ],
    manifests: [
      {
        id: "registry",
        rootId: "skills-root",
        path: {
          default: {
            base: "state",
            segments: ["fixture-agent", "registry.json"],
          },
        },
        format: "json",
        records: { pointer: "/skills", collection: "object-entries" },
        fields: {
          skillName: { kind: "record-key" },
          skillPath: { kind: "pointer", pointer: "/path" },
          managerId: { kind: "literal", value: "fixture-manager" },
        },
        metadata: [
          {
            namespace: "fixture",
            key: "channel",
            value: { kind: "pointer", pointer: "/channel" },
          },
        ],
      },
    ],
    ownershipRules: [
      {
        id: "manager-ownership",
        source: { kind: "root", rootId: "skills-root" },
        ownership: {
          kind: "manager",
          managerId: { kind: "literal", value: "fixture-manager" },
        },
        confidence: "declared",
      },
    ],
    groupingRules: [
      {
        id: "source-grouping",
        manifestId: "registry",
        evidence: {
          kind: "source",
          sourceId: { kind: "pointer", pointer: "/source" },
          skillPath: { kind: "pointer", pointer: "/path" },
        },
      },
    ],
    hardDependencies: [
      {
        id: "declared-dependency",
        manifestId: "registry",
        dependentInstallationId: {
          kind: "pointer",
          pointer: "/dependentId",
        },
        target: {
          kind: "plugin",
          pluginId: { kind: "pointer", pointer: "/pluginId" },
        },
        reason: { kind: "pointer", pointer: "/reason" },
      },
    ],
    verificationRules: [
      {
        id: "path-gone",
        kind: "path-absent",
        path: {
          default: {
            base: "home",
            segments: [".fixture-agent", "skills", "selected"],
          },
        },
      },
      {
        id: "record-gone",
        kind: "manifest-record-absent",
        manifestId: "registry",
        selector: { kind: "pointer", pointer: "/id" },
      },
      {
        id: "owner-gone",
        kind: "owner-state-absent",
        ownerKind: "manager",
        externalId: { kind: "pointer", pointer: "/id" },
      },
    ],
  };
}

function lifecycleDefinition(): AdapterDefinitionV2 {
  const legacy = readOnlyDefinition();
  const {
    schemaVersion: _schemaVersion,
    actions: _actions,
    ...common
  } = legacy;
  void _schemaVersion;
  void _actions;
  return {
    ...common,
    schemaVersion: 2,
    id: "fixture.lifecycle",
    verificationRules: [
      ...(legacy.verificationRules ?? []),
      {
        id: "path-remains",
        kind: "path-present",
        path: {
          default: {
            base: "home",
            segments: [".fixture-agent", "skills", "selected"],
          },
        },
      },
      {
        id: "revision-readable",
        kind: "revision-evidence",
        evidence: {
          kind: "content-hash",
          path: { kind: "value", from: "installationPath" },
        },
      },
    ],
    lifecycleOperations: [
      {
        id: "update-skill",
        lifecycle: "update",
        ownerKind: "manager",
        operationId: "update-skill",
        source: { kind: "manifest", manifestId: "registry" },
        requiresProbes: ["manager-present"],
        workingDirectory: {
          kind: "exact",
          path: { kind: "value", from: "scopePath" },
        },
        invocation: {
          kind: "direct",
          command: {
            default: {
              executable: "fixture-manager",
              arguments: [
                { kind: "literal", value: "update" },
                { kind: "value", from: "externalId" },
              ],
            },
          },
        },
        effects: [
          {
            kind: "mutation-root",
            path: { kind: "value", from: "installationPath" },
          },
          {
            kind: "configuration-path",
            path: { kind: "value", from: "manifestPath" },
          },
        ],
        network: {
          kind: "required",
          reason: "The Owner retrieves the recorded source revision.",
        },
        localChangeEvidence: {
          kind: "content-hash-match",
          algorithm: "sha256",
          path: { kind: "value", from: "installationPath" },
          manifestId: "registry",
          expectedDigest: { kind: "pointer", pointer: "/computedHash" },
        },
        verificationRules: ["revision-readable", "path-remains"],
      },
      {
        id: "remove-skill",
        lifecycle: "remove",
        ownerKind: "manager",
        operationId: "remove-skill",
        source: { kind: "manifest", manifestId: "registry" },
        requiresProbes: ["manager-present"],
        workingDirectory: { kind: "isolated-temporary" },
        invocation: {
          kind: "ephemeral-package",
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          mayDownload: true,
          arguments: [
            { kind: "literal", value: "remove" },
            { kind: "value", from: "externalId" },
          ],
        },
        effects: [
          {
            kind: "remove-path",
            path: { kind: "value", from: "installationPath" },
          },
        ],
        network: {
          kind: "required",
          reason: "The exact package may be downloaded before removal.",
        },
        verificationRules: ["path-gone"],
      },
    ],
  };
}

function asJsonc(definition: unknown): string {
  const json = JSON.stringify(definition, null, 2);
  return json
    .replace("{\n", "{\n  // JSONC comments are supported.\n")
    .replace(/\n}$/, ",\n}");
}

async function writeAdapter(
  path: string,
  definition: unknown,
): Promise<string> {
  const content = asJsonc(definition);
  await writeFile(path, content, "utf8");
  return content;
}

describe("Adapter loading", () => {
  it("publishes the v1 schema and deterministically compiles a read-only JSONC adapter", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "read-only.jsonc");
    await writeAdapter(adapterPath, readOnlyDefinition());
    const before = await Promise.all(
      [environment.config, environment.state, environment.cache].map((path) =>
        readdir(path),
      ),
    );
    const request = {
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: fixturePathBases(environment),
    } as const;

    const first = await loadAdapters(request);
    const second = await loadAdapters(request);

    expect(first).toEqual(second);
    expect(first.adapters).toHaveLength(5);
    const fixtureAdapter = first.adapters.find(
      (adapter) => adapter.id === "fixture.read-only",
    );
    const vercelAdapter = first.adapters.find(
      (adapter) => adapter.id === "vercel.skills",
    );
    const claudePluginAdapter = first.adapters.find(
      (adapter) => adapter.id === "claude-code.plugins",
    );
    const codexPluginAdapter = first.adapters.find(
      (adapter) => adapter.id === "codex.plugins",
    );
    expect(fixtureAdapter).toMatchObject({
      schemaVersion: 1,
      id: "fixture.read-only",
      trust: { kind: "read-only" },
      commandCapable: false,
    });
    expect(fixtureAdapter?.platforms).toEqual(["darwin", "linux", "win32"]);
    expect(fixtureAdapter?.lifecycleOperations).toEqual([]);
    expect(fixtureAdapter?.roots[0]?.path).toBe(
      join(environment.home, ".fixture-agent", "skills"),
    );
    expect(vercelAdapter).toMatchObject({
      id: "vercel.skills",
      trust: { kind: "built-in" },
      commandCapable: true,
    });
    expect(claudePluginAdapter).toMatchObject({
      id: "claude-code.plugins",
      trust: { kind: "built-in" },
      commandCapable: true,
    });
    expect(codexPluginAdapter).toMatchObject({
      id: "codex.plugins",
      trust: { kind: "built-in" },
      commandCapable: true,
    });
    expect(codexPluginAdapter?.actions[0]).toMatchObject({
      id: "remove-user-plugin",
      command: {
        executable: "codex",
        arguments: [
          { kind: "literal", value: "plugin" },
          { kind: "literal", value: "remove" },
          { kind: "value", from: "externalId" },
          { kind: "literal", value: "--json" },
        ],
      },
    });
    expect(
      claudePluginAdapter?.actions.find(
        (action) => action.id === "uninstall-project-plugin",
      ),
    ).toMatchObject({
      command: {
        executable: "claude",
        arguments: [
          { kind: "literal", value: "plugin" },
          { kind: "literal", value: "uninstall" },
          { kind: "value", from: "externalId" },
          { kind: "literal", value: "--scope" },
          { kind: "literal", value: "project" },
          { kind: "literal", value: "--yes" },
        ],
      },
    });
    expect(
      vercelAdapter?.actions.find(
        (action) => action.id === "remove-global-ephemeral",
      ),
    ).toMatchObject({
      runner: "npx",
      packageName: "skills",
      packageVersion: "1.5.22",
      mayDownload: true,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(fixtureAdapter?.manifests[0]?.metadata)).toBe(true);
    expect(
      await Promise.all(
        [environment.config, environment.state, environment.cache].map((path) =>
          readdir(path),
        ),
      ),
    ).toEqual(before);

    const schema = JSON.parse(
      await readFile(
        join(process.cwd(), "schemas", "adapter-v1.schema.json"),
        "utf8",
      ),
    ) as { readonly $schema?: string; readonly properties?: object };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties).toHaveProperty("schemaVersion");
  });

  it("requires approval for the exact raw content hash of command-capable local adapters", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "command.jsonc");
    const definition = {
      ...readOnlyDefinition(),
      id: "fixture.command",
      actions: [
        {
          id: "remove-skill",
          kind: "managed",
          ownerKind: "manager",
          operationId: "remove",
          requiresProbes: ["manager-present"],
          verificationRules: ["record-gone", "path-gone"],
          command: {
            default: {
              executable: "fixture-manager",
              arguments: [
                { kind: "literal", value: "remove" },
                { kind: "literal", value: "fish" },
                { kind: "value", from: "installationPath" },
              ],
            },
          },
        },
      ],
    };
    const content = await writeAdapter(adapterPath, definition);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const request = {
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: fixturePathBases(environment),
    } as const;

    const firstError = await loadAdapters(request).catch(
      (error: unknown) => error,
    );
    expect(firstError).toBeInstanceOf(AdapterTrustRequiredError);
    expect(firstError).toMatchObject({
      code: "trust-required",
      requirements: [
        {
          adapterId: "fixture.command",
          contentHash,
          path: adapterPath,
        },
      ],
    });

    const catalog = await loadAdapters({
      ...request,
      approvals: [{ adapterId: "fixture.command", contentHash }],
    });
    const commandAdapter = catalog.adapters.find(
      (adapter) => adapter.id === "fixture.command",
    );
    expect(commandAdapter?.trust).toEqual({
      kind: "approved",
      contentHash,
    });
    expect(commandAdapter?.actions[0]).toMatchObject({
      kind: "managed",
      verificationRules: ["path-gone", "record-gone"],
      command: { executable: "fixture-manager" },
    });
    expect(commandAdapter?.actions[0]?.kind).toBe("managed");
    if (commandAdapter?.actions[0]?.kind === "managed") {
      expect(commandAdapter.actions[0].command.arguments[1]).toEqual({
        kind: "literal",
        value: "fish",
      });
    }

    await writeFile(adapterPath, `${content}\n`, "utf8");
    await expect(
      loadAdapters({
        ...request,
        approvals: [{ adapterId: "fixture.command", contentHash }],
      }),
    ).rejects.toMatchObject({
      code: "trust-required",
      requirements: [
        {
          adapterId: "fixture.command",
          contentHash: createHash("sha256")
            .update(`${content}\n`)
            .digest("hex"),
        },
      ],
    });
  });

  it("publishes v2 and compiles explicit Update and Removal lifecycle operations", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "lifecycle.jsonc");
    const content = await writeAdapter(adapterPath, lifecycleDefinition());
    const contentHash = createHash("sha256").update(content).digest("hex");
    const request = {
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: fixturePathBases(environment),
      approvals: [{ adapterId: "fixture.lifecycle", contentHash }],
    } as const;

    await expect(
      loadAdapters({ ...request, approvals: [] }),
    ).rejects.toMatchObject({
      code: "trust-required",
      requirements: [{ adapterId: "fixture.lifecycle", contentHash }],
    });
    const first = await loadAdapters(request);
    const second = await loadAdapters(request);
    const adapter = first.adapters.find(
      (candidate) => candidate.id === "fixture.lifecycle",
    );

    expect(first).toEqual(second);
    expect(adapter).toMatchObject({
      schemaVersion: 2,
      commandCapable: true,
      trust: { kind: "approved", contentHash },
    });
    expect(
      adapter?.lifecycleOperations.map((operation) => operation.id),
    ).toEqual(["remove-skill", "update-skill"]);
    expect(
      adapter?.lifecycleOperations.find(
        (operation) => operation.lifecycle === "update",
      ),
    ).toMatchObject({
      adapterSchemaVersion: 2,
      lifecycle: "update",
      workingDirectory: { kind: "exact", value: "scopePath" },
      invocation: {
        kind: "direct",
        command: {
          executable: "fixture-manager",
          arguments: [
            { kind: "literal", value: "update" },
            { kind: "value", from: "externalId" },
          ],
        },
      },
      effects: [
        { kind: "mutation-root", value: "installationPath" },
        { kind: "configuration-path", value: "manifestPath" },
      ],
      network: { kind: "required" },
      localChangeEvidence: {
        kind: "content-hash-match",
        algorithm: "sha256",
        value: "installationPath",
        manifestId: "registry",
        expectedDigest: { kind: "pointer", pointer: "/computedHash" },
      },
      verificationRules: ["path-remains", "revision-readable"],
    });
    expect(adapter?.actions).toEqual([]);
    expect(Object.isFrozen(adapter?.lifecycleOperations)).toBe(true);

    const schema = JSON.parse(
      await readFile(
        join(process.cwd(), "schemas", "adapter-v2.schema.json"),
        "utf8",
      ),
    ) as { readonly $schema?: string; readonly properties?: object };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties).toHaveProperty("lifecycleOperations");
  });

  it("compiles an exact-version ephemeral Update invocation", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "ephemeral-update.jsonc");
    const definition = lifecycleDefinition();
    const ephemeralUpdate = {
      ...definition,
      id: "fixture.ephemeral-update",
      lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
        operation.lifecycle === "update"
          ? {
              ...operation,
              workingDirectory: { kind: "isolated-temporary" },
              invocation: {
                kind: "ephemeral-package",
                runner: "npx",
                packageName: "fixture-manager",
                packageVersion: "2.3.4-beta.1",
                mayDownload: true,
                arguments: [
                  { kind: "literal", value: "update" },
                  { kind: "value", from: "externalId" },
                ],
              },
            }
          : operation,
      ),
    };
    const content = await writeAdapter(adapterPath, ephemeralUpdate);
    const contentHash = createHash("sha256").update(content).digest("hex");

    const catalog = await loadAdapters({
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: fixturePathBases(environment),
      approvals: [{ adapterId: ephemeralUpdate.id, contentHash }],
    });
    const update = catalog.adapters
      .find((adapter) => adapter.id === ephemeralUpdate.id)
      ?.lifecycleOperations.find(
        (operation) => operation.lifecycle === "update",
      );

    expect(update).toMatchObject({
      lifecycle: "update",
      workingDirectory: { kind: "isolated-temporary" },
      invocation: {
        kind: "ephemeral-package",
        runner: "npx",
        packageName: "fixture-manager",
        packageVersion: "2.3.4-beta.1",
        mayDownload: true,
      },
    });
  });

  it.each([
    [
      "missing explicit lifecycle",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map(
          ({ lifecycle: _lifecycle, ...operation }) => {
            void _lifecycle;
            return operation;
          },
        ),
      }),
      "schema-invalid",
    ],
    [
      "Removal effect on Update",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
          operation.lifecycle === "update"
            ? {
                ...operation,
                effects: [
                  {
                    kind: "remove-path",
                    path: { kind: "value", from: "installationPath" },
                  },
                ],
              }
            : operation,
        ),
      }),
      "schema-invalid",
    ],
    [
      "empty effects",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map(
          (operation) => ({
            ...operation,
            effects: [],
          }),
        ),
      }),
      "schema-invalid",
    ],
    [
      "missing network disclosure",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map(
          ({ network: _network, ...operation }) => {
            void _network;
            return operation;
          },
        ),
      }),
      "schema-invalid",
    ],
    [
      "no-network ephemeral package",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
          operation.invocation.kind === "ephemeral-package"
            ? { ...operation, network: { kind: "none" } }
            : operation,
        ),
      }),
      "schema-invalid",
    ],
    [
      "mutable Update package version",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
          operation.lifecycle === "update"
            ? {
                ...operation,
                invocation: {
                  kind: "ephemeral-package",
                  runner: "npx",
                  packageName: "fixture-manager",
                  packageVersion: "latest",
                  mayDownload: true,
                  arguments: [],
                },
              }
            : operation,
        ),
      }),
      "schema-invalid",
    ],
    [
      "missing local-change evidence",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map(
          (operation) => {
            if (operation.lifecycle !== "update") return operation;
            const { localChangeEvidence: _evidence, ...incomplete } = operation;
            void _evidence;
            return incomplete;
          },
        ),
      }),
      "schema-invalid",
    ],
    [
      "Removal verification on Update",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
          operation.lifecycle === "update"
            ? { ...operation, verificationRules: ["path-gone"] }
            : operation,
        ),
      }),
      "invalid-reference",
    ],
    [
      "no revision verification",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
          operation.lifecycle === "update"
            ? { ...operation, verificationRules: ["path-remains"] }
            : operation,
        ),
      }),
      "invalid-reference",
    ],
    [
      "duplicate operation ID",
      (definition: AdapterDefinitionV2) => ({
        ...definition,
        lifecycleOperations: definition.lifecycleOperations?.map(
          (operation) => ({
            ...operation,
            operationId: "same-operation",
          }),
        ),
      }),
      "duplicate-id",
    ],
  ])("rejects invalid v2 %s before trust", async (_name, mutate, code) => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "invalid-v2.jsonc");
    await writeAdapter(adapterPath, mutate(lifecycleDefinition()));

    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toMatchObject({ code });
  });

  it("rejects unsafe v2 Update commands before exact-hash trust", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "unsafe-v2.jsonc");
    const definition = lifecycleDefinition();
    await writeAdapter(adapterPath, {
      ...definition,
      lifecycleOperations: definition.lifecycleOperations?.map((operation) =>
        operation.lifecycle === "update"
          ? {
              ...operation,
              invocation: {
                kind: "direct",
                command: {
                  default: {
                    executable: "fixture-manager",
                    arguments: [{ kind: "literal", value: "|" }],
                  },
                },
              },
            }
          : operation,
      ),
    });

    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toMatchObject({ code: "unsafe-command" });
  });

  it("selects operating-system variants using platform path semantics", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "platforms.jsonc");
    const definition = readOnlyDefinition();
    const root = definition.roots?.[0];
    if (root === undefined) {
      throw new Error("fixture root is missing");
    }
    await writeAdapter(adapterPath, {
      ...definition,
      probes: [
        {
          id: "manager-present",
          kind: "executable",
          executable: { default: "fixture", win32: "fixture.exe" },
        },
      ],
      roots: [
        {
          ...root,
          path: {
            default: { base: "home", segments: [".fixture", "skills"] },
            win32: { base: "home", segments: ["Fixture", "Skills"] },
          },
        },
      ],
    });
    const windowsBases: AdapterPathBases = {
      home: "C:\\Users\\fixture",
      workspace: "C:\\work",
      config: "C:\\config",
      state: "C:\\state",
      cache: "C:\\cache",
      temporary: "C:\\temp",
    };

    const catalog = await loadAdapters({
      localAdapterPaths: [adapterPath],
      platform: "win32",
      pathBases: windowsBases,
    });
    const variantsAdapter = catalog.adapters.find(
      (adapter) => adapter.id === "fixture.read-only",
    );

    expect(variantsAdapter?.probes[0]).toMatchObject({
      kind: "executable",
      executable: "fixture.exe",
    });
    expect(variantsAdapter?.roots[0]?.path).toBe(
      win32.join(windowsBases.home, "Fixture", "Skills"),
    );
  });

  it.each([
    ["shell executable", { executable: "sh", arguments: [] }],
    ["C shell executable", { executable: "csh", arguments: [] }],
    [
      "shell launcher",
      {
        executable: "env",
        arguments: [
          { kind: "literal", value: "sh" },
          { kind: "literal", value: "-c" },
          { kind: "literal", value: "echo unsafe" },
        ],
      },
    ],
    [
      "shell interpolation",
      {
        executable: "fixture-manager",
        arguments: [{ kind: "literal", value: "${installationPath}" }],
      },
    ],
    [
      "shell control token",
      {
        executable: "fixture-manager",
        arguments: [{ kind: "literal", value: "|" }],
      },
    ],
  ])("rejects unsafe %s before trust", async (_name, command) => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "unsafe.jsonc");
    await writeAdapter(adapterPath, {
      ...readOnlyDefinition(),
      id: "fixture.unsafe",
      actions: [
        {
          id: "unsafe-action",
          kind: "managed",
          ownerKind: "manager",
          operationId: "remove",
          command: { default: command },
        },
      ],
    });

    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toMatchObject({ code: "unsafe-command" });
  });

  it("rejects remote, executable, duplicate-key, unsupported-version, duplicate-id, and missing-reference definitions", async () => {
    const environment = await createTestEnvironment();
    const bases = fixturePathBases(environment);
    await expect(
      loadAdapters({
        localAdapterPaths: ["https://example.com/adapter.jsonc"],
      }),
    ).rejects.toMatchObject({ code: "unsupported-source" });
    await expect(
      loadAdapters({
        localAdapterPaths: ["\\\\server\\share\\adapter.jsonc"],
      }),
    ).rejects.toMatchObject({ code: "unsupported-source" });

    const executablePath = join(environment.temporary, "adapter.js");
    await writeFile(executablePath, "export default {};", "utf8");
    await expect(
      loadAdapters({ localAdapterPaths: [executablePath] }),
    ).rejects.toMatchObject({ code: "unsupported-source" });

    const duplicateKeyPath = join(environment.temporary, "duplicate-key.jsonc");
    await writeFile(
      duplicateKeyPath,
      '{"schemaVersion":1,"id":"first","id":"second","name":"x","platforms":["linux"]}',
      "utf8",
    );
    await expect(
      loadAdapters({ localAdapterPaths: [duplicateKeyPath] }),
    ).rejects.toMatchObject({ code: "parse-failed" });

    const unsupportedPath = join(environment.temporary, "unsupported.jsonc");
    await writeAdapter(unsupportedPath, {
      ...readOnlyDefinition(),
      schemaVersion: 3,
    });
    await expect(
      loadAdapters({ localAdapterPaths: [unsupportedPath] }),
    ).rejects.toMatchObject({ code: "unsupported-version" });

    const duplicateIdPath = join(environment.temporary, "duplicate-id.jsonc");
    const fixtureRoot = readOnlyDefinition().roots?.[0];
    if (fixtureRoot === undefined) {
      throw new Error("fixture root is missing");
    }
    await writeAdapter(duplicateIdPath, {
      ...readOnlyDefinition(),
      roots: [fixtureRoot, fixtureRoot],
    });
    await expect(
      loadAdapters({
        localAdapterPaths: [duplicateIdPath],
        platform: supportedPlatform(),
        pathBases: bases,
      }),
    ).rejects.toMatchObject({ code: "duplicate-id" });

    const badReferencePath = join(environment.temporary, "bad-reference.jsonc");
    await writeAdapter(badReferencePath, {
      ...readOnlyDefinition(),
      roots: [
        {
          ...fixtureRoot,
          requiresProbes: ["missing-probe"],
        },
      ],
    });
    await expect(
      loadAdapters({
        localAdapterPaths: [badReferencePath],
        platform: supportedPlatform(),
        pathBases: bases,
      }),
    ).rejects.toMatchObject({ code: "invalid-reference" });

    const invalidRootPath = join(environment.temporary, "invalid-root.jsonc");
    await writeAdapter(invalidRootPath, {
      ...readOnlyDefinition(),
      roots: [{ ...fixtureRoot, independentlySelectable: true }],
    });
    await expect(
      loadAdapters({
        localAdapterPaths: [invalidRootPath],
        platform: supportedPlatform(),
        pathBases: bases,
      }),
    ).rejects.toMatchObject({ code: "schema-invalid" });
  });

  it("accepts Windows extended local drive adapter paths", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "extended-local.jsonc");
    await writeAdapter(adapterPath, readOnlyDefinition());

    const catalog = await loadAdapters({
      localAdapterPaths: [toNamespacedPath(adapterPath)],
      platform: "win32",
      pathBases: fixturePathBases(environment),
    });

    expect(
      catalog.adapters.filter((adapter) => adapter.id === "fixture.read-only"),
    ).toHaveLength(1);
  });

  it("rejects mutable ephemeral package versions and accepts exact Semantic Versions", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "ephemeral.jsonc");
    const ephemeralDefinition = (
      packageVersion: string,
      packageName = "fixture-manager",
      runner = "npx",
    ) => ({
      ...readOnlyDefinition(),
      id: "fixture.ephemeral",
      actions: [
        {
          id: "ephemeral-remove",
          kind: "ephemeral-package",
          ownerKind: "manager",
          operationId: "remove",
          runner,
          packageName,
          packageVersion,
          mayDownload: true,
          arguments: [{ kind: "value", from: "installationPath" }],
        },
      ],
    });
    await writeAdapter(adapterPath, ephemeralDefinition("^1.2.3"));
    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toMatchObject({ code: "schema-invalid" });

    await writeAdapter(
      adapterPath,
      ephemeralDefinition("1.2.3", "fixture-manager", "pnpm"),
    );
    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toMatchObject({ code: "schema-invalid" });

    await writeAdapter(
      adapterPath,
      ephemeralDefinition("1.2.3", "fixture-manager@latest"),
    );
    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toMatchObject({ code: "schema-invalid" });

    const content = await writeAdapter(
      adapterPath,
      ephemeralDefinition("1.2.3-beta.1+build.7"),
    );
    const contentHash = createHash("sha256").update(content).digest("hex");
    const catalog = await loadAdapters({
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: fixturePathBases(environment),
      approvals: [{ adapterId: "fixture.ephemeral", contentHash }],
    });
    const ephemeralAdapter = catalog.adapters.find(
      (adapter) => adapter.id === "fixture.ephemeral",
    );
    expect(ephemeralAdapter?.actions[0]).toMatchObject({
      kind: "ephemeral-package",
      packageVersion: "1.2.3-beta.1+build.7",
      runner: "npx",
      mayDownload: true,
    });
  });

  it("rejects shell command strings at the schema boundary", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "shell-string.jsonc");
    await writeAdapter(adapterPath, {
      ...readOnlyDefinition(),
      actions: [
        {
          id: "shell-string-action",
          kind: "managed",
          ownerKind: "manager",
          operationId: "remove",
          command: "fixture-manager remove | cleanup",
        },
      ],
    });

    await expect(
      loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: fixturePathBases(environment),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AdapterLoadError && error.code === "schema-invalid",
    );
  });
});

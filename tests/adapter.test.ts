import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, toNamespacedPath, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdapterLoadError,
  AdapterTrustRequiredError,
  loadAdapters,
  type AdapterDefinitionV1,
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
    expect(first.adapters).toHaveLength(3);
    const fixtureAdapter = first.adapters.find(
      (adapter) => adapter.id === "fixture.read-only",
    );
    const vercelAdapter = first.adapters.find(
      (adapter) => adapter.id === "vercel.skills",
    );
    const claudePluginAdapter = first.adapters.find(
      (adapter) => adapter.id === "claude-code.plugins",
    );
    expect(fixtureAdapter).toMatchObject({
      id: "fixture.read-only",
      trust: { kind: "read-only" },
      commandCapable: false,
    });
    expect(fixtureAdapter?.platforms).toEqual(["darwin", "linux", "win32"]);
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
      schemaVersion: 2,
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

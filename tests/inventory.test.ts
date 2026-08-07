import {
  access,
  mkdir,
  readdir,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createInventoryScanner,
  InventoryScanError,
  plan,
  stringifyModel,
  type DiscoveryRoot,
  type InventoryCommand,
  type InventoryCommandRunner,
  type Installation,
  type InventoryScanEnvironment,
  loadAdapters,
  type AdapterDefinitionV1,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-02-03T04:05:06.000Z");
const unavailableCommandRunner: InventoryCommandRunner = {
  async run() {
    return { exitCode: null, stdout: "" };
  },
};

function supportedPlatform(): "darwin" | "linux" | "win32" {
  if (
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
  )
    return process.platform;
  throw new Error("unsupported platform");
}

function createScanner(
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner = unavailableCommandRunner,
) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner,
  });
}

function unusedDefaultEnvironment(
  environment: Awaited<ReturnType<typeof createTestEnvironment>>,
): InventoryScanEnvironment {
  return {
    homeDirectory: join(environment.home, "unused-default-home"),
    workspaceDirectory: join(environment.workspace, "unused-default-workspace"),
  };
}

function adapterBases(
  environment: Awaited<ReturnType<typeof createTestEnvironment>>,
) {
  return {
    home: environment.home,
    workspace: environment.workspace,
    config: environment.config,
    state: environment.state,
    cache: environment.cache,
    temporary: environment.temporary,
  };
}

async function writeAdapter(
  environment: Awaited<ReturnType<typeof createTestEnvironment>>,
  definition: AdapterDefinitionV1,
): Promise<string> {
  const path = join(environment.temporary, `${definition.id}.jsonc`);
  await writeFile(path, JSON.stringify(definition), "utf8");
  return path;
}

function createGitCommandRunner(
  worktreeRoot: string,
  ignoredPaths: readonly string[] = [],
  observedCommands: InventoryCommand[] = [],
): InventoryCommandRunner {
  return {
    async run(command) {
      observedCommands.push(command);
      if (
        command.executable !== "git" ||
        command.arguments[0] !== "-C" ||
        command.arguments[1] === undefined
      ) {
        return { exitCode: null, stdout: "" };
      }
      if (
        command.arguments.length === 4 &&
        command.arguments[2] === "rev-parse" &&
        command.arguments[3] === "--show-toplevel"
      ) {
        return { exitCode: 0, stdout: `${worktreeRoot}\n` };
      }
      if (
        command.arguments.length !== 6 ||
        command.arguments[2] !== "check-ignore" ||
        command.arguments[3] !== "--quiet" ||
        command.arguments[4] !== "--"
      ) {
        return { exitCode: null, stdout: "" };
      }
      const candidatePath = command.arguments.at(-1);
      return {
        exitCode:
          candidatePath !== undefined && ignoredPaths.includes(candidatePath)
            ? 0
            : 1,
        stdout: "",
      };
    },
  };
}

async function createSkill(
  directoryPath: string,
  options: {
    readonly name: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly body?: string;
  },
): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
  const tags = options.tags ?? [];
  const content = [
    "---",
    `name: ${options.name}`,
    ...(options.description === undefined
      ? []
      : [`description: ${options.description}`]),
    ...(tags.length === 0 ? [] : ["tags:", ...tags.map((tag) => `  - ${tag}`)]),
    "---",
    options.body ?? `# ${options.name}`,
    "",
  ].join("\n");
  const skillFilePath = join(directoryPath, "SKILL.md");
  await writeFile(skillFilePath, content, "utf8");
  await utimes(skillFilePath, fixedTime, fixedTime);
}

async function createDirectoryLink(
  targetPath: string,
  linkPath: string,
): Promise<void> {
  await symlink(
    targetPath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function installationByName(
  installations: readonly Installation[],
  name: string,
): Installation {
  const installation = installations.find((item) => item.skill.name === name);
  if (installation === undefined) {
    throw new Error(`installation not found: ${name}`);
  }
  return installation;
}

async function snapshotDirectory(directoryPath: string): Promise<string[]> {
  const snapshot: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const pathFromRoot = relative(directoryPath, entryPath)
        .split(sep)
        .join("/");
      if (entry.isDirectory()) {
        snapshot.push(`directory:${pathFromRoot}`);
        await visit(entryPath);
      } else {
        snapshot.push(
          `file:${pathFromRoot}:${await readFile(entryPath, "utf8")}`,
        );
      }
    }
  }

  await visit(directoryPath);
  return snapshot;
}

describe("Inventory scan", () => {
  it.each([
    [
      "jsonc",
      '{ // comment\n "skills": [{ "path": "fish", "name": "Manifest Fish", "description": "From registry", "source": "example/source", "url": "https://example.com/source", "tags": ["first", "second"], "status": "unresolved", "vendor": "fixture" }], }',
    ],
    [
      "yaml",
      "skills:\n  - path: fish\n    name: Manifest Fish\n    description: From registry\n    source: example/source\n    url: https://example.com/source\n    tags: [first, second]\n    status: unresolved\n    vendor: fixture\n",
    ],
  ] as const)(
    "materializes bounded %s manifest records without scan writes",
    async (format, content) => {
      const environment = await createTestEnvironment();
      const root = join(environment.home, ".format-fixture");
      await createSkill(join(root, "fish"), { name: "fish" });
      const manifest = join(environment.state, `registry.${format}`);
      await writeFile(manifest, content, "utf8");
      const catalog = await loadAdapters({
        localAdapterPaths: [
          await writeAdapter(environment, {
            schemaVersion: 1,
            id: `fixture.${format}`,
            name: format,
            platforms: [supportedPlatform()],
            roots: [
              {
                id: "root",
                kind: "user",
                agentId: "fixture",
                path: {
                  default: { base: "home", segments: [".format-fixture"] },
                },
              },
            ],
            manifests: [
              {
                id: "registry",
                rootId: "root",
                path: {
                  default: { base: "state", segments: [`registry.${format}`] },
                },
                format,
                records: { pointer: "/skills", collection: "array" },
                fields: {
                  skillPath: { kind: "pointer", pointer: "/path" },
                  skillName: { kind: "pointer", pointer: "/name" },
                  description: { kind: "pointer", pointer: "/description" },
                  sourceId: { kind: "pointer", pointer: "/source" },
                  sourceUrl: { kind: "pointer", pointer: "/url" },
                  tags: { kind: "pointer", pointer: "/tags" },
                  status: { kind: "pointer", pointer: "/status" },
                },
                metadata: [
                  {
                    namespace: "fixture",
                    key: "vendor",
                    value: { kind: "pointer", pointer: "/vendor" },
                  },
                ],
              },
            ],
          }),
        ],
        platform: supportedPlatform(),
        pathBases: adapterBases(environment),
      });
      const before = await snapshotDirectory(environment.root);
      const inventory = await createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({});
      expect(inventory.installations.map((item) => item.location.path)).toEqual(
        [join(root, "fish")],
      );
      expect(inventory.installations[0]).toMatchObject({
        skill: { name: "Manifest Fish", description: "From registry" },
        source: {
          id: "example/source",
          url: "https://example.com/source",
        },
        tags: ["first", "second"],
        status: "unresolved",
        metadata: { fixture: { vendor: "fixture" } },
      });
      expect(inventory.installations[0]?.identity.weakEvidence).toContainEqual({
        strength: "weak",
        kind: "name",
        normalizedName: "manifest fish",
      });
      expect(await snapshotDirectory(environment.root)).toEqual(before);
    },
  );

  it.each([
    ["json", '{"skills":{"one":{"path":"fish"},"one":{"path":"fish"}}}'],
    ["jsonc", '{"skills":{"one":{"path":"fish"},"one":{"path":"fish"}}}'],
    ["yaml", "skills:\n  one: { path: fish }\n  one: { path: fish }\n"],
    ["json", "{"],
    ["jsonc", "/* unterminated"],
    ["yaml", "skills: ["],
  ] as const)(
    "leaves malformed or duplicate-key %s evidence inert",
    async (format, content) => {
      const environment = await createTestEnvironment();
      const root = join(environment.home, ".invalid-fixture");
      await createSkill(join(root, "fish"), { name: "fish" });
      const manifest = join(environment.state, `invalid.${format}`);
      await writeFile(manifest, content, "utf8");
      const catalog = await loadAdapters({
        localAdapterPaths: [
          await writeAdapter(environment, {
            schemaVersion: 1,
            id: `fixture.invalid-${format}`,
            name: "invalid",
            platforms: [supportedPlatform()],
            roots: [
              {
                id: "root",
                kind: "user",
                agentId: "fixture",
                path: {
                  default: { base: "home", segments: [".invalid-fixture"] },
                },
              },
            ],
            manifests: [
              {
                id: "registry",
                rootId: "root",
                path: {
                  default: { base: "state", segments: [`invalid.${format}`] },
                },
                format,
                records: { pointer: "/skills", collection: "object-values" },
                fields: { skillPath: { kind: "pointer", pointer: "/path" } },
              },
            ],
          }),
        ],
        platform: supportedPlatform(),
        pathBases: adapterBases(environment),
      });
      const inventory = await createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({});
      expect(inventory.installations).toHaveLength(1);
      expect(inventory.installations[0]?.ownership).toEqual({
        kind: "filesystem",
        confidence: "inferred",
      });
    },
  );
  it("keeps an adapter inert when its declared root escapes the selected base through a parent link", async () => {
    const environment = await createTestEnvironment();
    const outside = join(environment.temporary, "outside-skills");
    await createSkill(join(outside, "fish"), { name: "fish" });
    await createDirectoryLink(outside, join(environment.home, "linked-skills"));
    const manifest = join(environment.state, "registry.json");
    await writeFile(manifest, '{"skills":[{"path":"fish"}]}', "utf8");
    const catalog = await loadAdapters({
      localAdapterPaths: [
        await writeAdapter(environment, {
          schemaVersion: 1,
          id: "fixture.link-escape",
          name: "Link escape",
          platforms: [supportedPlatform()],
          roots: [
            {
              id: "root",
              kind: "user",
              agentId: "fixture",
              path: { default: { base: "home", segments: ["linked-skills"] } },
            },
          ],
          manifests: [
            {
              id: "manifest",
              rootId: "root",
              path: { default: { base: "state", segments: ["registry.json"] } },
              format: "json",
              records: { pointer: "/skills", collection: "array" },
              fields: { skillPath: { kind: "pointer", pointer: "/path" } },
            },
          ],
        }),
      ],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
    });
    const inventory = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
    }).scan({});
    expect(inventory.installations).toEqual([]);
  });
  it("rejects forged catalog provenance and duplicate catalog root boundaries", async () => {
    const environment = await createTestEnvironment();
    const definition: AdapterDefinitionV1 = {
      schemaVersion: 1,
      id: "fixture.provenance",
      name: "Provenance",
      platforms: [supportedPlatform()],
      roots: [
        {
          id: "one",
          kind: "user",
          agentId: "fixture",
          path: { default: { base: "home", segments: ["shared"] } },
        },
        {
          id: "two",
          kind: "user",
          agentId: "fixture",
          path: { default: { base: "home", segments: ["shared"] } },
        },
      ],
    };
    const catalog = await loadAdapters({
      localAdapterPaths: [await writeAdapter(environment, definition)],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
    });
    const scanner = createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
    });
    await expect(
      scanner.scan({
        roots: [
          {
            kind: "user",
            path: join(environment.home, "other"),
            agentId: "fixture",
            adapterId: definition.id,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(scanner.scan({})).rejects.toMatchObject({
      code: "invalid-request",
    });
  });
  it("materializes one exact approved adapter manifest record into planner-ready ownership and removal evidence", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, ".fixture", "skills");
    const skill = join(root, "fish");
    await createSkill(skill, { name: "generic fish" });
    const manifest = join(environment.state, "fixture-registry.json");
    await writeFile(
      manifest,
      JSON.stringify({
        skills: { fish: { path: "fish", external: "fixture/fish" } },
      }),
      "utf8",
    );
    const definition: AdapterDefinitionV1 = {
      schemaVersion: 1,
      id: "fixture.inventory",
      name: "Fixture",
      platforms: [supportedPlatform()],
      probes: [
        {
          id: "present",
          kind: "executable",
          executable: { default: "fixture-manager" },
        },
      ],
      roots: [
        {
          id: "root",
          kind: "user",
          agentId: "fixture",
          path: { default: { base: "home", segments: [".fixture", "skills"] } },
        },
      ],
      manifests: [
        {
          id: "registry",
          rootId: "root",
          path: {
            default: { base: "state", segments: ["fixture-registry.json"] },
          },
          format: "json",
          records: { pointer: "/skills", collection: "object-values" },
          fields: {
            skillPath: { kind: "pointer", pointer: "/path" },
            externalId: { kind: "pointer", pointer: "/external" },
          },
        },
      ],
      ownershipRules: [
        {
          id: "owner",
          source: { kind: "manifest", manifestId: "registry" },
          ownership: {
            kind: "manager",
            managerId: { kind: "literal", value: "fixture-manager" },
          },
          confidence: "declared",
        },
      ],
      actions: [
        {
          id: "remove",
          kind: "managed",
          source: { kind: "manifest", manifestId: "registry" },
          ownerKind: "manager",
          operationId: "remove",
          requiresProbes: ["present"],
          verificationRules: ["path", "record", "owner-check", "command"],
          effects: [
            {
              kind: "remove-path",
              path: { kind: "value", from: "installationPath" },
            },
          ],
          command: {
            default: {
              executable: "fixture-manager",
              arguments: [
                { kind: "literal", value: "remove" },
                { kind: "value", from: "externalId" },
              ],
            },
          },
        },
      ],
      verificationRules: [
        {
          id: "path",
          kind: "path-absent",
          path: {
            default: { base: "home", segments: [".fixture", "skills", "fish"] },
          },
        },
        {
          id: "record",
          kind: "manifest-record-absent",
          manifestId: "registry",
          selector: { kind: "literal", value: "fixture/fish" },
        },
        {
          id: "owner-check",
          kind: "owner-state-absent",
          ownerKind: "manager",
          externalId: { kind: "literal", value: "fixture/fish" },
        },
        {
          id: "command",
          kind: "command",
          command: {
            default: {
              executable: "fixture-manager",
              arguments: [
                { kind: "literal", value: "verify" },
                { kind: "value", from: "externalId" },
              ],
            },
          },
          successExitCodes: [0],
        },
      ],
    };
    const adapterPath = join(environment.temporary, "fixture.jsonc");
    await writeFile(adapterPath, JSON.stringify(definition), "utf8");
    const catalog = await loadAdapters({
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: {
        home: environment.home,
        workspace: environment.workspace,
        config: environment.config,
        state: environment.state,
        cache: environment.cache,
        temporary: environment.temporary,
      },
      approvals: [
        {
          adapterId: "fixture.inventory",
          contentHash: createHash("sha256")
            .update(await readFile(adapterPath))
            .digest("hex"),
        },
      ],
    });
    const inventory = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
      executablePresent: async () => true,
    }).scan({});
    const installation = inventory.installations.find(
      (item) => item.location.path === skill,
    );
    expect(installation?.ownership).toEqual({
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    });
    expect(installation?.removal.managed).toMatchObject({
      externalId: "fixture/fish",
      invocation: {
        kind: "direct",
        command: {
          executable: "fixture-manager",
          arguments: ["remove", "fixture/fish"],
        },
      },
    });
    expect(
      installation?.removal.managed?.verifications.map((item) => item.kind),
    ).toEqual([
      "command-succeeds",
      "owner-state-absent",
      "path-absent",
      "record-absent",
    ]);
    const ephemeralDefinition: AdapterDefinitionV1 = {
      ...definition,
      id: "fixture.inventory.ephemeral",
      actions: [
        {
          id: "remove-ephemeral",
          kind: "ephemeral-package",
          source: { kind: "manifest", manifestId: "registry" },
          ownerKind: "manager",
          operationId: "remove",
          requiresProbes: ["present"],
          verificationRules: ["path", "record", "owner-check", "command"],
          effects: [
            {
              kind: "remove-path",
              path: { kind: "value", from: "installationPath" },
            },
          ],
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          mayDownload: true,
          arguments: [
            { kind: "literal", value: "remove" },
            { kind: "value", from: "externalId" },
          ],
        },
      ],
    };
    const ephemeralPath = await writeAdapter(environment, ephemeralDefinition);
    const ephemeralCatalog = await loadAdapters({
      localAdapterPaths: [ephemeralPath],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
      approvals: [
        {
          adapterId: ephemeralDefinition.id,
          contentHash: createHash("sha256")
            .update(await readFile(ephemeralPath))
            .digest("hex"),
        },
      ],
    });
    const ephemeralInventory = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: ephemeralCatalog,
      executablePresent: async () => true,
    }).scan({});
    expect(ephemeralInventory.installations[0]?.removal.managed).toMatchObject({
      invocation: {
        kind: "ephemeral-package",
        packageExecution: {
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          mayDownload: true,
        },
        packageArguments: ["remove", "fixture/fish"],
      },
      effects: [{ kind: "remove-path", path: skill }],
    });
    const ephemeralInstallation = ephemeralInventory.installations[0];
    expect(ephemeralInstallation).toBeDefined();
    const ephemeralPlan = plan(ephemeralInventory, {
      kind: "targets",
      targets: [
        {
          kind: "installation",
          installationId: ephemeralInstallation!.id,
        },
      ],
      mode: "managed-first",
      force: false,
    });
    expect(ephemeralPlan.actions).toMatchObject([
      {
        kind: "managed-removal",
        invocation: {
          kind: "ephemeral-package",
          packageExecution: {
            runner: "npx",
            packageName: "fixture-manager",
            packageVersion: "1.2.3",
            mayDownload: true,
          },
          packageArguments: ["remove", "fixture/fish"],
        },
      },
    ]);
    expect(ephemeralPlan.warnings).toContainEqual(
      expect.objectContaining({
        kind: "ephemeral-download",
        packageExecution: expect.objectContaining({
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          mayDownload: true,
        }),
      }),
    );
    expect(
      plan(inventory, {
        kind: "targets",
        targets: [{ kind: "installation", installationId: installation!.id }],
        mode: "managed-first",
        force: false,
      }),
    ).toMatchObject({ actions: [{ kind: "managed-removal" }] });

    const absentProbe = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
      executablePresent: async () => false,
    }).scan({});
    const unavailable = absentProbe.installations.find(
      (item) => item.location.path === skill,
    );
    expect(unavailable?.ownership.kind).toBe("manager");
    expect(unavailable?.removal).toMatchObject({
      fallback: { kind: "unavailable" },
      managed: { availability: { kind: "unavailable" } },
    });
    expect(
      plan(absentProbe, {
        kind: "targets",
        targets: [{ kind: "installation", installationId: unavailable!.id }],
        mode: "managed-first",
        force: false,
      }).actions,
    ).toEqual([]);

    await writeFile(
      manifest,
      JSON.stringify({
        skills: {
          fish: { path: "fish", external: "fixture/fish" },
          duplicate: { path: "fish", external: "fixture/fish-copy" },
        },
      }),
      "utf8",
    );
    const duplicate = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
      executablePresent: async () => true,
    }).scan({});
    const generic = duplicate.installations.find(
      (item) => item.location.path === skill,
    );
    expect(generic?.ownership).toEqual({
      kind: "filesystem",
      confidence: "inferred",
    });
    expect(generic?.removal.managed).toBeNull();
  });
  it("turns manifest grouping and hard dependencies into observable inventory and planning outcomes", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, ".dependency-fixture");
    await Promise.all([
      createSkill(join(root, "target"), { name: "target" }),
      createSkill(join(root, "dependent"), { name: "dependent" }),
    ]);
    const manifest = join(environment.state, "dependency-registry.json");
    const definition: AdapterDefinitionV1 = {
      schemaVersion: 1,
      id: "fixture.dependencies",
      name: "Dependency fixture",
      platforms: [supportedPlatform()],
      roots: [
        {
          id: "skills",
          kind: "user",
          agentId: "fixture",
          path: {
            default: { base: "home", segments: [".dependency-fixture"] },
          },
        },
      ],
      manifests: [
        {
          id: "registry",
          rootId: "skills",
          path: {
            default: { base: "state", segments: ["dependency-registry.json"] },
          },
          format: "json",
          records: { pointer: "/skills", collection: "array" },
          fields: { skillPath: { kind: "pointer", pointer: "/path" } },
        },
      ],
      groupingRules: [
        {
          id: "shared-source",
          manifestId: "registry",
          evidence: {
            kind: "source",
            sourceId: { kind: "pointer", pointer: "/source" },
            skillPath: { kind: "pointer", pointer: "/sourcePath" },
          },
        },
      ],
      hardDependencies: [
        {
          id: "requires-target",
          manifestId: "registry",
          dependentInstallationId: {
            kind: "pointer",
            pointer: "/dependentInstallationId",
          },
          target: {
            kind: "installation",
            installationId: {
              kind: "pointer",
              pointer: "/targetInstallationId",
            },
          },
          reason: { kind: "pointer", pointer: "/reason" },
        },
      ],
    };
    const catalog = await loadAdapters({
      localAdapterPaths: [await writeAdapter(environment, definition)],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
    });
    const scanner = createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
    });

    // Inventory IDs are intentionally opaque. A baseline public scan supplies
    // the exact IDs which this external manager manifest records.
    const baseline = await scanner.scan({});
    const targetId = installationByName(baseline.installations, "target").id;
    const dependentId = installationByName(
      baseline.installations,
      "dependent",
    ).id;
    await writeFile(
      manifest,
      JSON.stringify({
        skills: [
          {
            path: "target",
            source: "example/source",
            sourcePath: "skills/shared",
            dependentInstallationId: "",
            targetInstallationId: targetId,
            reason: "",
          },
          {
            path: "dependent",
            source: "example/source",
            sourcePath: "skills/shared",
            dependentInstallationId: dependentId,
            targetInstallationId: targetId,
            reason: "dependent requires target",
          },
        ],
      }),
      "utf8",
    );

    const inventory = await scanner.scan({});
    const target = installationByName(inventory.installations, "target");
    const dependent = installationByName(inventory.installations, "dependent");
    expect(inventory.logicalSkills).toContainEqual(
      expect.objectContaining({
        installationIds: expect.arrayContaining([target.id, dependent.id]),
      }),
    );
    expect(inventory.dependencies).toContainEqual({
      kind: "hard",
      dependentInstallationId: dependent.id,
      target: { kind: "installation", installationId: target.id },
      source: { kind: "adapter", adapterId: definition.id },
      reason: "dependent requires target",
    });
    const blocked = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: target.id }],
      mode: "managed-first",
      force: false,
    });
    expect(blocked.blocks).toContainEqual(
      expect.objectContaining({ kind: "hard-dependency" }),
    );
    const ordered = plan(inventory, {
      kind: "targets",
      targets: [
        { kind: "installation", installationId: target.id },
        { kind: "installation", installationId: dependent.id },
      ],
      mode: "managed-first",
      force: false,
    });
    expect(
      ordered.actions.map((action) => action.affectedInstallationIds),
    ).toEqual([[dependent.id], [target.id]]);
    expect(ordered.actions[1]?.dependsOn).toEqual([ordered.actions[0]?.id]);
  });

  it("keeps canonical escapes inert while preserving safe static and contextual adapter effects", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, ".path-safety-fixture");
    const skill = join(root, "fish");
    await createSkill(skill, { name: "fish" });
    const manifest = join(environment.state, "registry.json");
    await writeFile(
      manifest,
      JSON.stringify({ skills: [{ path: "fish", external: "fixture/fish" }] }),
      "utf8",
    );
    const approvedCatalog = async (definition: AdapterDefinitionV1) => {
      const adapterPath = await writeAdapter(environment, definition);
      return loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: adapterBases(environment),
        approvals: [
          {
            adapterId: definition.id,
            contentHash: createHash("sha256")
              .update(await readFile(adapterPath))
              .digest("hex"),
          },
        ],
      });
    };
    const definition = (
      id: string,
      effect: NonNullable<
        NonNullable<AdapterDefinitionV1["actions"]>[number]["effects"]
      >[number],
    ): AdapterDefinitionV1 => ({
      schemaVersion: 1,
      id,
      name: "Path safety fixture",
      platforms: [supportedPlatform()],
      roots: [
        {
          id: "skills",
          kind: "user",
          agentId: "fixture",
          path: {
            default: { base: "home", segments: [".path-safety-fixture"] },
          },
        },
      ],
      manifests: [
        {
          id: "registry",
          rootId: "skills",
          path: { default: { base: "state", segments: ["registry.json"] } },
          format: "json",
          records: { pointer: "/skills", collection: "array" },
          fields: {
            skillPath: { kind: "pointer", pointer: "/path" },
            externalId: { kind: "pointer", pointer: "/external" },
          },
        },
      ],
      ownershipRules: [
        {
          id: "owner",
          source: { kind: "manifest", manifestId: "registry" },
          ownership: {
            kind: "manager",
            managerId: { kind: "literal", value: "fixture-manager" },
          },
          confidence: "declared",
        },
      ],
      actions: [
        {
          id: "remove",
          kind: "managed",
          source: { kind: "manifest", manifestId: "registry" },
          ownerKind: "manager",
          operationId: "remove",
          effects: [effect],
          command: {
            default: {
              executable: "fixture-manager",
              arguments: [{ kind: "value", from: "externalId" }],
            },
          },
        },
      ],
    });
    const scan = async (catalog: Awaited<ReturnType<typeof approvedCatalog>>) =>
      createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({});

    const outside = join(environment.temporary, "outside");
    await mkdir(outside, { recursive: true });
    await createDirectoryLink(outside, join(environment.home, "linked-effect"));
    const escapedEffect = await scan(
      await approvedCatalog(
        definition("fixture.effect-escape", {
          kind: "remove-path",
          path: {
            kind: "static",
            path: { default: { base: "home", segments: ["linked-effect"] } },
          },
        }),
      ),
    );
    expect(
      installationByName(escapedEffect.installations, "fish").removal.managed,
    ).toBeNull();

    const safeEffect = join(environment.home, "managed-state");
    await mkdir(safeEffect, { recursive: true });
    const acceptedEffect = await scan(
      await approvedCatalog(
        definition("fixture.effect-contained", {
          kind: "remove-path",
          path: {
            kind: "static",
            path: { default: { base: "home", segments: ["managed-state"] } },
          },
        }),
      ),
    );
    expect(
      installationByName(acceptedEffect.installations, "fish").removal.managed
        ?.effects,
    ).toEqual([
      expect.objectContaining({ kind: "remove-path", path: safeEffect }),
    ]);

    const linkTarget = join(environment.temporary, "linked-skill-target");
    await createSkill(linkTarget, { name: "linked fish" });
    const linkedRoot = join(environment.home, ".contextual-path-fixture");
    const linkedSkill = join(linkedRoot, "fish");
    await mkdir(linkedRoot, { recursive: true });
    await createDirectoryLink(linkTarget, linkedSkill);
    await writeFile(
      manifest,
      JSON.stringify({ skills: [{ path: "fish", external: "fixture/fish" }] }),
      "utf8",
    );
    const contextual = await scan(
      await approvedCatalog({
        ...definition("fixture.contextual-link", {
          kind: "remove-path",
          path: { kind: "value", from: "installationPath" },
        }),
        roots: [
          {
            id: "skills",
            kind: "user",
            agentId: "fixture",
            path: {
              default: { base: "home", segments: [".contextual-path-fixture"] },
            },
          },
        ],
      }),
    );
    const linkedInstallation = installationByName(
      contextual.installations,
      "linked fish",
    );
    expect(linkedInstallation.location.path).toBe(linkedSkill);
    expect(linkedInstallation.removal.managed?.effects).toEqual([
      expect.objectContaining({ kind: "remove-path", path: linkedSkill }),
    ]);

    const manifestOutside = join(environment.temporary, "outside-manifest");
    await mkdir(manifestOutside, { recursive: true });
    await writeFile(
      join(manifestOutside, "registry.json"),
      JSON.stringify({ skills: [{ path: "fish", external: "fixture/fish" }] }),
      "utf8",
    );
    await createDirectoryLink(
      manifestOutside,
      join(environment.state, "linked-manifest"),
    );
    const escapedManifest = await scan(
      await approvedCatalog({
        ...definition("fixture.manifest-escape", {
          kind: "remove-path",
          path: { kind: "value", from: "installationPath" },
        }),
        manifests: [
          {
            id: "registry",
            rootId: "skills",
            path: {
              default: {
                base: "state",
                segments: ["linked-manifest", "registry.json"],
              },
            },
            format: "json",
            records: { pointer: "/skills", collection: "array" },
            fields: {
              skillPath: { kind: "pointer", pointer: "/path" },
              externalId: { kind: "pointer", pointer: "/external" },
            },
          },
        ],
      }),
    );
    expect(
      installationByName(escapedManifest.installations, "fish").ownership,
    ).toEqual({
      kind: "filesystem",
      confidence: "inferred",
    });
  });

  it("fails closed on conflicting, incomplete, and effectless manifest authority", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, ".authority-fixture");
    await createSkill(join(root, "fish"), { name: "fish" });
    const manifest = join(environment.state, "authority-registry.json");
    const base = (id: string): AdapterDefinitionV1 => ({
      schemaVersion: 1,
      id,
      name: "Authority fixture",
      platforms: [supportedPlatform()],
      roots: [
        {
          id: "skills",
          kind: "user",
          agentId: "fixture",
          path: { default: { base: "home", segments: [".authority-fixture"] } },
        },
      ],
      manifests: [
        {
          id: "registry",
          rootId: "skills",
          path: {
            default: { base: "state", segments: ["authority-registry.json"] },
          },
          format: "json",
          records: { pointer: "/skills", collection: "array" },
          fields: {
            skillPath: { kind: "pointer", pointer: "/path" },
            externalId: { kind: "pointer", pointer: "/external" },
          },
        },
      ],
    });
    const managerOwnership = (id: string, managerId: string) => ({
      id,
      source: { kind: "manifest" as const, manifestId: "registry" },
      ownership: {
        kind: "manager" as const,
        managerId: { kind: "literal" as const, value: managerId },
      },
      confidence: "declared" as const,
    });
    const action = (
      id: string,
      effects?: NonNullable<
        NonNullable<AdapterDefinitionV1["actions"]>[number]["effects"]
      >,
    ) => ({
      id,
      kind: "managed" as const,
      source: { kind: "manifest" as const, manifestId: "registry" },
      ownerKind: "manager" as const,
      operationId: "remove",
      ...(effects === undefined ? {} : { effects }),
      command: {
        default: {
          executable: "fixture-manager",
          arguments: [{ kind: "value" as const, from: "externalId" as const }],
        },
      },
    });
    const contextualEffects = [
      {
        kind: "remove-path" as const,
        path: { kind: "value" as const, from: "installationPath" as const },
      },
    ];
    const scan = async (definition: AdapterDefinitionV1) => {
      const adapterPath = await writeAdapter(environment, definition);
      const catalog = await loadAdapters({
        localAdapterPaths: [adapterPath],
        platform: supportedPlatform(),
        pathBases: adapterBases(environment),
        approvals: [
          {
            adapterId: definition.id,
            contentHash: createHash("sha256")
              .update(await readFile(adapterPath))
              .digest("hex"),
          },
        ],
      });
      return createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({});
    };
    const managedPlan = (inventory: Awaited<ReturnType<typeof scan>>) => {
      const installation = installationByName(inventory.installations, "fish");
      return plan(inventory, {
        kind: "targets",
        targets: [{ kind: "installation", installationId: installation.id }],
        mode: "managed-first",
        force: false,
      });
    };

    await writeFile(
      manifest,
      JSON.stringify({ skills: [{ path: "fish" }] }),
      "utf8",
    );
    const conflictingOwnership = await scan({
      ...base("fixture.conflicting-ownership"),
      ownershipRules: [
        managerOwnership("first", "manager-one"),
        managerOwnership("second", "manager-two"),
      ],
    });
    expect(
      installationByName(conflictingOwnership.installations, "fish").ownership,
    ).toEqual({
      kind: "filesystem",
      confidence: "inferred",
    });
    expect(
      installationByName(conflictingOwnership.installations, "fish").removal
        .fallback.kind,
    ).toBe("available");
    expect(managedPlan(conflictingOwnership).actions).not.toContainEqual(
      expect.objectContaining({ kind: "managed-removal" }),
    );

    const rootAndManifestConflict = await scan({
      ...base("fixture.root-manifest-conflict"),
      ownershipRules: [
        managerOwnership("manifest-owner", "fixture-manager"),
        {
          id: "root-owner",
          source: { kind: "root", rootId: "skills" },
          ownership: {
            kind: "manager",
            managerId: { kind: "literal", value: "fixture-manager" },
          },
          confidence: "declared",
        },
      ],
    });
    expect(
      installationByName(rootAndManifestConflict.installations, "fish")
        .ownership.kind,
    ).toBe("filesystem");

    await writeFile(
      manifest,
      JSON.stringify({ skills: [{ path: "fish", external: "fixture/fish" }] }),
      "utf8",
    );
    const twoActions = await scan({
      ...base("fixture.conflicting-actions"),
      ownershipRules: [managerOwnership("owner", "fixture-manager")],
      actions: [
        action("first", contextualEffects),
        action("second", contextualEffects),
      ],
    });
    const twoActionInstallation = installationByName(
      twoActions.installations,
      "fish",
    );
    expect(twoActionInstallation.ownership).toMatchObject({
      kind: "manager",
      managerId: "fixture-manager",
    });
    expect(twoActionInstallation.removal).toMatchObject({
      managed: null,
      fallback: { kind: "unavailable" },
    });
    expect(managedPlan(twoActions).actions).toEqual([]);

    await writeFile(
      manifest,
      JSON.stringify({
        skills: [{ path: "fish" }, { external: "fixture/fish" }],
      }),
      "utf8",
    );
    const crossRecord = await scan({
      ...base("fixture.cross-record"),
      ownershipRules: [managerOwnership("owner", "fixture-manager")],
      actions: [action("remove", contextualEffects)],
    });
    expect(
      installationByName(crossRecord.installations, "fish").removal.managed,
    ).toBeNull();
    expect(managedPlan(crossRecord).actions).toEqual([]);

    await writeFile(
      manifest,
      JSON.stringify({
        skills: [{ path: "../outside", external: "fixture/fish" }],
      }),
      "utf8",
    );
    const unsafePath = await scan({
      ...base("fixture.unsafe-path"),
      ownershipRules: [managerOwnership("owner", "fixture-manager")],
      actions: [action("remove", contextualEffects)],
    });
    expect(
      installationByName(unsafePath.installations, "fish").ownership.kind,
    ).toBe("filesystem");

    await writeFile(
      manifest,
      JSON.stringify({ skills: [{ path: "fish", external: "fixture/fish" }] }),
      "utf8",
    );
    const effectless = await scan({
      ...base("fixture.effectless"),
      ownershipRules: [managerOwnership("owner", "fixture-manager")],
      actions: [action("remove")],
    });
    expect(
      installationByName(effectless.installations, "fish").removal,
    ).toMatchObject({
      managed: null,
      fallback: { kind: "unavailable" },
    });
    expect(managedPlan(effectless).actions).toEqual([]);
  });

  it("limits adapter authority to active roots and preserves metadata-only manifest evidence", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, ".probe-authority-fixture");
    await createSkill(join(root, "fish"), { name: "generic fish" });
    await writeFile(
      join(environment.state, "active.json"),
      JSON.stringify({
        skills: [
          {
            path: "fish",
            external: "active/fish",
            name: "active fish",
            manager: "active-manager",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(environment.state, "inactive.json"),
      JSON.stringify({ skills: [{ path: "fish", external: "inactive/fish" }] }),
      "utf8",
    );
    const definition: AdapterDefinitionV1 = {
      schemaVersion: 1,
      id: "fixture.probe-authority",
      name: "Probe authority fixture",
      platforms: [supportedPlatform()],
      probes: [
        {
          id: "unavailable",
          kind: "executable",
          executable: { default: "unavailable-manager" },
        },
      ],
      roots: [
        {
          id: "active",
          kind: "user",
          agentId: "fixture",
          path: {
            default: { base: "home", segments: [".probe-authority-fixture"] },
          },
        },
        {
          id: "inactive",
          kind: "user",
          agentId: "fixture",
          requiresProbes: ["unavailable"],
          path: {
            default: { base: "home", segments: [".probe-authority-fixture"] },
          },
        },
      ],
      manifests: [
        {
          id: "active-record",
          rootId: "active",
          path: { default: { base: "state", segments: ["active.json"] } },
          format: "json",
          records: { pointer: "/skills", collection: "array" },
          fields: {
            skillPath: { kind: "pointer", pointer: "/path" },
            externalId: { kind: "pointer", pointer: "/external" },
            skillName: { kind: "pointer", pointer: "/name" },
            managerId: { kind: "pointer", pointer: "/manager" },
          },
        },
        {
          id: "inactive-record",
          rootId: "inactive",
          path: { default: { base: "state", segments: ["inactive.json"] } },
          format: "json",
          records: { pointer: "/skills", collection: "array" },
          fields: {
            skillPath: { kind: "pointer", pointer: "/path" },
            externalId: { kind: "pointer", pointer: "/external" },
          },
        },
      ],
      ownershipRules: [
        {
          id: "active-root-owner",
          source: { kind: "root", rootId: "active" },
          ownership: {
            kind: "manager",
            managerId: { kind: "literal", value: "active-manager" },
          },
          confidence: "declared",
        },
        {
          id: "inactive-manifest-owner",
          source: { kind: "manifest", manifestId: "inactive-record" },
          ownership: {
            kind: "manager",
            managerId: { kind: "literal", value: "inactive-manager" },
          },
          confidence: "declared",
        },
      ],
      actions: [
        {
          id: "active-root-action",
          kind: "managed",
          source: { kind: "root", rootId: "active" },
          ownerKind: "manager",
          operationId: "remove",
          effects: [
            {
              kind: "remove-path",
              path: { kind: "value", from: "installationPath" },
            },
          ],
          command: {
            default: {
              executable: "active-manager",
              arguments: [{ kind: "value", from: "externalId" }],
            },
          },
        },
      ],
    };
    const adapterPath = await writeAdapter(environment, definition);
    const catalog = await loadAdapters({
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
      approvals: [
        {
          adapterId: definition.id,
          contentHash: createHash("sha256")
            .update(await readFile(adapterPath))
            .digest("hex"),
        },
      ],
    });
    const inventory = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
      executablePresent: async () => false,
    }).scan({});
    const installation = installationByName(
      inventory.installations,
      "active fish",
    );
    expect(installation.ownership).toEqual({
      kind: "manager",
      managerId: "active-manager",
      confidence: "declared",
    });
    expect(installation.removal.managed).toMatchObject({
      externalId: "active/fish",
      invocation: { kind: "direct", command: { arguments: ["active/fish"] } },
    });
    expect(
      plan(inventory, {
        kind: "targets",
        targets: [{ kind: "installation", installationId: installation.id }],
        mode: "managed-first",
        force: false,
      }).actions,
    ).toContainEqual(expect.objectContaining({ kind: "managed-removal" }));

    await writeFile(
      join(environment.state, "active.json"),
      JSON.stringify({
        skills: [
          {
            path: "fish",
            external: "active/fish",
            name: "wrong manager evidence",
            manager: "wrong-manager",
          },
        ],
      }),
      "utf8",
    );
    const mismatch = await createInventoryScanner({
      now: () => fixedTime,
      environment: unusedDefaultEnvironment(environment),
      commandRunner: unavailableCommandRunner,
      adapterCatalog: catalog,
      executablePresent: async () => false,
    }).scan({});
    const mismatchedInstallation = installationByName(
      mismatch.installations,
      "generic fish",
    );
    expect(mismatchedInstallation.ownership).toMatchObject({
      kind: "manager",
      managerId: "active-manager",
    });
    expect(mismatchedInstallation.removal.managed).toBeNull();
    expect(
      plan(mismatch, {
        kind: "targets",
        targets: [
          { kind: "installation", installationId: mismatchedInstallation.id },
        ],
        mode: "managed-first",
        force: false,
      }).actions,
    ).toEqual([]);

    const canonicalRoot = join(environment.home, "canonical-root");
    await mkdir(canonicalRoot, { recursive: true });
    await createDirectoryLink(
      canonicalRoot,
      join(environment.home, "canonical-alias"),
    );
    const aliasCatalog = await loadAdapters({
      localAdapterPaths: [
        await writeAdapter(environment, {
          schemaVersion: 1,
          id: "fixture.canonical-root-conflict",
          name: "Canonical root conflict",
          platforms: [supportedPlatform()],
          roots: [
            {
              id: "root",
              kind: "user",
              agentId: "fixture",
              path: { default: { base: "home", segments: ["canonical-root"] } },
            },
            {
              id: "alias",
              kind: "user",
              agentId: "fixture",
              path: {
                default: { base: "home", segments: ["canonical-alias"] },
              },
            },
          ],
        }),
      ],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
    });
    await expect(
      createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: aliasCatalog,
      }).scan({}),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("rejects nested active adapter roots before parent discovery can hide child provenance", async () => {
    const environment = await createTestEnvironment();
    const parent = join(environment.home, ".nested-root-fixture");
    await createSkill(parent, { name: "parent" });
    await createSkill(join(parent, "child"), { name: "child" });
    const catalog = await loadAdapters({
      localAdapterPaths: [
        await writeAdapter(environment, {
          schemaVersion: 1,
          id: "fixture.nested-roots",
          name: "Nested roots",
          platforms: [supportedPlatform()],
          roots: [
            {
              id: "parent",
              kind: "user",
              agentId: "fixture",
              path: {
                default: { base: "home", segments: [".nested-root-fixture"] },
              },
            },
            {
              id: "child",
              kind: "user",
              agentId: "fixture",
              path: {
                default: {
                  base: "home",
                  segments: [".nested-root-fixture", "child"],
                },
              },
            },
          ],
          ownershipRules: [
            {
              id: "parent-owner",
              source: { kind: "root", rootId: "parent" },
              ownership: {
                kind: "manager",
                managerId: { kind: "literal", value: "parent-manager" },
              },
              confidence: "declared",
            },
            {
              id: "child-owner",
              source: { kind: "root", rootId: "child" },
              ownership: {
                kind: "manager",
                managerId: { kind: "literal", value: "child-manager" },
              },
              confidence: "declared",
            },
          ],
        }),
      ],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
    });
    await expect(
      createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({}),
    ).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("corroborates declared plugin fields against the physical plugin boundary", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, ".plugin-field-fixture");
    await createSkill(join(root, "fish"), { name: "plugin fish" });
    const manifest = join(environment.state, "plugin-fields.json");
    const writeManifest = async (pluginId: string, pluginVersion: unknown) =>
      writeFile(
        manifest,
        JSON.stringify({
          skills: [
            {
              path: "fish",
              external: "fixture/fish",
              pluginId,
              pluginVersion,
            },
          ],
        }),
        "utf8",
      );
    await writeManifest("fixture-plugin", null);
    const definition: AdapterDefinitionV1 = {
      schemaVersion: 1,
      id: "fixture.plugin-fields",
      name: "Plugin field fixture",
      platforms: [supportedPlatform()],
      roots: [
        {
          id: "plugin",
          kind: "plugin",
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "fixture-plugin", version: null },
          independentlySelectable: true,
          path: {
            default: { base: "home", segments: [".plugin-field-fixture"] },
          },
        },
      ],
      manifests: [
        {
          id: "registry",
          rootId: "plugin",
          path: {
            default: { base: "state", segments: ["plugin-fields.json"] },
          },
          format: "json",
          records: { pointer: "/skills", collection: "array" },
          fields: {
            skillPath: { kind: "pointer", pointer: "/path" },
            externalId: { kind: "pointer", pointer: "/external" },
            pluginId: { kind: "pointer", pointer: "/pluginId" },
            pluginVersion: { kind: "pointer", pointer: "/pluginVersion" },
          },
        },
      ],
      actions: [
        {
          id: "remove",
          kind: "managed",
          source: { kind: "root", rootId: "plugin" },
          ownerKind: "plugin",
          operationId: "remove",
          effects: [
            {
              kind: "remove-path",
              path: { kind: "value", from: "installationPath" },
            },
          ],
          command: {
            default: {
              executable: "fixture-plugin-manager",
              arguments: [{ kind: "value", from: "externalId" }],
            },
          },
        },
      ],
    };
    const adapterPath = await writeAdapter(environment, definition);
    const catalog = await loadAdapters({
      localAdapterPaths: [adapterPath],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
      approvals: [
        {
          adapterId: definition.id,
          contentHash: createHash("sha256")
            .update(await readFile(adapterPath))
            .digest("hex"),
        },
      ],
    });
    const scan = () =>
      createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({});
    const valid = await scan();
    const validInstallation = installationByName(
      valid.installations,
      "plugin fish",
    );
    expect(validInstallation.plugin).toEqual({
      id: "fixture-plugin",
      version: null,
    });
    expect(validInstallation.removal.managed).toMatchObject({
      externalId: "fixture/fish",
    });

    await writeManifest("fixture-plugin", "1.0.0");
    const versionMismatch = await scan();
    expect(
      installationByName(versionMismatch.installations, "plugin fish"),
    ).toMatchObject({
      plugin: { id: "fixture-plugin", version: null },
      removal: { managed: null },
    });

    await writeManifest("", null);
    const blankPluginId = await scan();
    expect(
      installationByName(blankPluginId.installations, "plugin fish").removal
        .managed,
    ).toBeNull();
  });

  it("uses a semantic Inventory ID that ignores scan time and changes with protection evidence", async () => {
    const environment = await createTestEnvironment();
    const rootPath = join(environment.home, ".agents", "skills");
    const skillPath = join(rootPath, "stable");
    await createSkill(skillPath, { name: "stable" });
    const request = {
      roots: [
        {
          kind: "user" as const,
          path: rootPath,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    };
    const scanEnvironment = unusedDefaultEnvironment(environment);

    const first = await createInventoryScanner({
      now: () => fixedTime,
      environment: scanEnvironment,
      commandRunner: unavailableCommandRunner,
    }).scan(request);
    const later = await createInventoryScanner({
      now: () => new Date("2026-02-04T04:05:06.000Z"),
      environment: scanEnvironment,
      commandRunner: unavailableCommandRunner,
    }).scan(request);
    const protectedInventory = await createInventoryScanner({
      now: () => new Date("2026-02-05T04:05:06.000Z"),
      environment: scanEnvironment,
      commandRunner: createGitCommandRunner(environment.home),
    }).scan(request);

    expect(later.scannedAt).not.toBe(first.scannedAt);
    expect(later.id).toBe(first.id);
    expect(protectedInventory.id).not.toBe(first.id);
    expect(protectedInventory.installations[0]?.protection.git.kind).toBe(
      "protected",
    );
  });

  it("classifies bounded user, agent, workspace, plugin, and inspection roots", async () => {
    const environment = await createTestEnvironment();
    const userRoot = join(environment.home, ".agents", "skills");
    const agentRoot = join(environment.home, ".fixture-agent", "skills");
    const workspaceRoot = join(environment.workspace, ".agents", "skills");
    const pluginRoot = join(environment.home, ".plugins", "fixture", "skills");
    const sourceRoot = join(environment.workspace, "skill-sources");
    const cacheRoot = join(environment.cache, "skill-cache");
    const systemRoot = join(
      environment.home,
      ".fixture-agent",
      "system-skills",
    );
    const unknownRoot = join(environment.temporary, "unknown-skills");

    await Promise.all([
      createSkill(join(userRoot, "nested", "alpha"), {
        name: "alpha",
        description: "User skill",
        tags: ["second", "first"],
      }),
      createSkill(join(agentRoot, "beta"), { name: "beta" }),
      createSkill(join(workspaceRoot, "project"), { name: "project" }),
      createSkill(join(pluginRoot, "plugin-skill"), { name: "plugin-skill" }),
      createSkill(join(sourceRoot, "source-skill"), { name: "source-skill" }),
      createSkill(join(cacheRoot, "cached-skill"), { name: "cached-skill" }),
      createSkill(join(systemRoot, "runtime-skill"), { name: "runtime-skill" }),
      createSkill(join(unknownRoot, "mystery"), { name: "mystery" }),
    ]);

    const roots: DiscoveryRoot[] = [
      { kind: "user", path: userRoot, agentId: "fixture", adapterId: null },
      { kind: "agent", path: agentRoot, agentId: "fixture", adapterId: null },
      {
        kind: "workspace",
        path: workspaceRoot,
        workspacePath: environment.workspace,
        agentId: "fixture",
        adapterId: null,
      },
      {
        kind: "plugin",
        path: pluginRoot,
        agentId: "fixture",
        scope: { kind: "user" },
        plugin: { id: "fixture-plugin", version: "1.0.0" },
        independentlySelectable: false,
        adapterId: "fixture-plugin-adapter",
      },
      {
        kind: "source",
        path: sourceRoot,
        agentId: null,
        scope: null,
        source: { id: "fixture-source", url: "https://example.com/source" },
        adapterId: null,
      },
      {
        kind: "cache-or-vendor",
        path: cacheRoot,
        agentId: null,
        scope: null,
        adapterId: null,
      },
      { kind: "system", path: systemRoot, agentId: "fixture", adapterId: null },
      {
        kind: "unknown",
        path: unknownRoot,
        agentId: null,
        scope: null,
        adapterId: null,
      },
    ];

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({ roots });

    expect(
      inventory.installations.map((item) => item.skill.name).sort(),
    ).toEqual(["alpha", "beta", "plugin-skill", "project"]);
    expect(
      inventory.otherFindings.map((item) => [
        item.skill.name,
        item.classification,
      ]),
    ).toEqual([
      ["cached-skill", "cache-or-vendor-artifact"],
      ["runtime-skill", "system-skill"],
      ["mystery", "unknown"],
      ["source-skill", "source-artifact"],
    ]);

    const alpha = installationByName(inventory.installations, "alpha");
    expect(alpha.skill.description).toBe("User skill");
    expect(alpha.tags).toEqual(["first", "second"]);
    expect(alpha.contentHash).toMatch(/^[a-f\d]{64}$/);
    expect(alpha.scope).toEqual({ kind: "user" });

    const project = installationByName(inventory.installations, "project");
    expect(project.classification).toBe("standalone-project-skill");
    expect(project.scope).toEqual({
      kind: "workspace",
      workspacePath: environment.workspace,
    });

    const plugin = installationByName(inventory.installations, "plugin-skill");
    expect(plugin.classification).toBe("managed-plugin-resource");
    expect(plugin.ownership).toEqual({
      kind: "plugin",
      pluginId: "fixture-plugin",
      independentlySelectable: false,
      confidence: "declared",
    });

    const source = inventory.otherFindings.find(
      (item) => item.classification === "source-artifact",
    );
    expect(source?.source).toEqual({
      id: "fixture-source",
      url: "https://example.com/source",
    });
    expect(source?.contentHash).toMatch(/^[a-f\d]{64}$/);

    const system = inventory.otherFindings.find(
      (item) => item.classification === "system-skill",
    );
    expect(system?.protection.system).toEqual({
      kind: "system-skill",
      agentId: "fixture",
    });
  });

  it("keeps identical external Plugin IDs in distinct physical boundaries", async () => {
    const environment = await createTestEnvironment();
    const userPluginRoot = join(environment.home, "plugins", "shared");
    const workspacePluginRoot = join(
      environment.workspace,
      ".plugins",
      "shared",
    );
    await Promise.all([
      createSkill(join(userPluginRoot, "skills", "user-child"), {
        name: "user-child",
      }),
      createSkill(join(workspacePluginRoot, "skills", "workspace-child"), {
        name: "workspace-child",
      }),
    ]);

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: userPluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "shared-plugin", version: "1.0.0" },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
        {
          kind: "plugin",
          path: workspacePluginRoot,
          agentId: "fixture",
          scope: {
            kind: "workspace",
            workspacePath: environment.workspace,
          },
          plugin: { id: "shared-plugin", version: "1.0.0" },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });

    expect(inventory.plugins).toHaveLength(2);
    expect(inventory.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "shared-plugin",
      "shared-plugin",
    ]);
    expect(new Set(inventory.plugins.map((plugin) => plugin.id)).size).toBe(2);
    expect(
      new Set(
        inventory.installations.map(
          (installation) => installation.pluginBoundaryId,
        ),
      ).size,
    ).toBe(2);
  });

  it("materializes the declared Plugin root so fallback quarantines all collateral atomically", async () => {
    const environment = await createTestEnvironment();
    const pluginRoot = join(environment.home, "plugins", "complete-plugin");
    const skillPath = join(pluginRoot, "skills", "plugin-child");
    const hookPath = join(pluginRoot, "hooks", "pre-run.js");
    const linkedTarget = join(environment.workspace, "linked-plugin-child");
    await createSkill(skillPath, { name: "plugin-child" });
    await createSkill(linkedTarget, { name: "linked-plugin-child" });
    await createDirectoryLink(linkedTarget, join(pluginRoot, "linked-child"));
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(hookPath, "export default function preRun() {}\n", "utf8");

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: pluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "complete-plugin", version: "1.0.0" },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });
    const boundary = inventory.plugins[0]!;

    expect(boundary.resources).toContainEqual(
      expect.objectContaining({
        kind: "other",
        id: "declared-root",
        location: expect.objectContaining({ path: pluginRoot }),
      }),
    );

    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    const quarantineActions = removalPlan.actions.filter(
      (action) => action.kind === "quarantine",
    );

    expect(quarantineActions).toHaveLength(1);
    expect(quarantineActions[0]).toMatchObject({
      location: {
        path: pluginRoot,
        artifactType: { kind: "directory" },
      },
      affectedInstallationIds: inventory.installations
        .map((installation) => installation.id)
        .sort(),
    });
    expect(removalPlan.verificationChecks).toContainEqual(
      expect.objectContaining({ kind: "path-absent", path: pluginRoot }),
    );
  });

  it("retains an existing Plugin boundary even when it contains no Skills", async () => {
    const environment = await createTestEnvironment();
    const pluginRoot = join(environment.home, "plugins", "empty-plugin");
    await mkdir(pluginRoot, { recursive: true });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: pluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "empty-plugin", version: null },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });

    expect(inventory.installations).toEqual([]);
    expect(inventory.plugins).toHaveLength(1);
    expect(inventory.plugins[0]).toMatchObject({
      pluginId: "empty-plugin",
      installationIds: [],
      resources: [
        {
          id: "declared-root",
          location: { path: pluginRoot },
        },
      ],
    });
    const boundary = inventory.plugins[0]!;
    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    expect(removalPlan.actions).toMatchObject([
      {
        kind: "quarantine",
        location: { path: pluginRoot },
        affectedInstallationIds: [],
      },
    ]);
  });

  it("uses the writable parent as permission evidence for a broken Plugin root link", async () => {
    const environment = await createTestEnvironment();
    const pluginParent = join(environment.home, "plugins");
    const pluginRoot = join(pluginParent, "broken-plugin");
    await mkdir(pluginParent, { recursive: true });
    await createDirectoryLink(
      join(environment.workspace, "missing-plugin-target"),
      pluginRoot,
    );

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: pluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "broken-plugin", version: null },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });
    const boundary = inventory.plugins[0]!;
    const rootResource = boundary.resources.find(
      (resource) => resource.id === "declared-root",
    )!;

    expect(rootResource.location?.artifactType).toMatchObject({
      broken: true,
    });
    expect(rootResource.protection?.filesystem).toEqual({ kind: "writable" });
    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    expect(removalPlan.blocks).toEqual([]);
    expect(removalPlan.actions).toMatchObject([
      { kind: "quarantine", location: { path: pluginRoot } },
    ]);
  });

  it("recognizes links, junctions, broken links, strong groups, and weak hints", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, "linked-skills");
    const target = join(environment.workspace, "linked-source");
    await mkdir(root, { recursive: true });
    await createSkill(target, { name: "linked-skill", body: "same target" });
    await createDirectoryLink(target, join(root, "linked-one"));
    await createDirectoryLink(target, join(root, "linked-two"));
    await createDirectoryLink(
      join(environment.workspace, "missing-target"),
      join(root, "broken-skill"),
    );
    await createSkill(join(root, "copy-one"), {
      name: "copied-skill",
      body: "identical copy",
    });
    await createSkill(join(root, "copy-two"), {
      name: "copied-skill",
      body: "identical copy",
    });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        { kind: "user", path: root, agentId: "fixture", adapterId: null },
      ],
    });
    const linkedOne = installationByName(
      inventory.installations,
      "linked-skill",
    );
    const linkedInstallations = inventory.installations.filter(
      (item) => item.skill.name === "linked-skill",
    );
    expect(linkedInstallations).toHaveLength(2);
    expect(linkedOne.location.artifactType.kind).toBe(
      process.platform === "win32" ? "junction" : "symbolic-link",
    );
    expect(linkedInstallations[0]?.location.canonicalPath).toBe(
      linkedInstallations[1]?.location.canonicalPath,
    );
    expect(
      inventory.logicalSkills.some(
        (logicalSkill) => logicalSkill.installationIds.length === 2,
      ),
    ).toBe(true);

    const copies = inventory.installations.filter(
      (item) => item.skill.name === "copied-skill",
    );
    expect(copies).toHaveLength(2);
    expect(copies[0]?.contentHash).toBe(copies[1]?.contentHash);
    expect(
      inventory.logicalSkills.some((logicalSkill) =>
        copies.every((copy) => logicalSkill.installationIds.includes(copy.id)),
      ),
    ).toBe(false);
    expect(
      inventory.identityHints.some(
        (hint) =>
          hint.evidence.kind === "content-hash" &&
          copies.every((copy) => hint.installationIds.includes(copy.id)),
      ),
    ).toBe(true);

    const broken = inventory.installations.find(
      (item) => item.location.path === join(root, "broken-skill"),
    );
    expect(broken?.status).toBe("broken");
    expect(broken?.location.canonicalPath).toBeNull();
    expect(broken?.location.artifactType).toMatchObject({
      kind: process.platform === "win32" ? "junction" : "symbolic-link",
      broken: true,
    });
  });

  it("marks every non-ignored worktree skill as protected", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.workspace, ".agents", "skills");
    await createSkill(join(root, "protected-skill"), {
      name: "protected-skill",
    });
    await createSkill(join(root, "ignored-skill"), { name: "ignored-skill" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
      createGitCommandRunner(environment.workspace, [
        ".agents/skills/ignored-skill",
      ]),
    ).scan({
      roots: [
        {
          kind: "workspace",
          path: root,
          workspacePath: environment.workspace,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    });

    expect(
      installationByName(inventory.installations, "protected-skill").protection
        .git,
    ).toEqual({ kind: "protected", worktreeRoot: environment.workspace });
    expect(
      installationByName(inventory.installations, "ignored-skill").protection
        .git,
    ).toEqual({ kind: "ignored", worktreeRoot: environment.workspace });
  });

  it("protects a Skill directory that is itself a worktree root", async () => {
    const environment = await createTestEnvironment();
    const worktreeRoot = join(environment.workspace, "skill-worktree");
    const observedCommands: InventoryCommand[] = [];
    await createSkill(worktreeRoot, { name: "worktree-skill" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
      createGitCommandRunner(worktreeRoot, [], observedCommands),
    ).scan({
      roots: [
        {
          kind: "workspace",
          path: worktreeRoot,
          workspacePath: worktreeRoot,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    });

    expect(inventory.installations[0]?.protection.git).toEqual({
      kind: "protected",
      worktreeRoot,
    });
    expect(
      observedCommands.filter((command) => command.executable === "git"),
    ).toEqual([
      {
        executable: "git",
        arguments: ["-C", worktreeRoot, "rev-parse", "--show-toplevel"],
      },
      {
        executable: "git",
        arguments: ["-C", worktreeRoot, "check-ignore", "--quiet", "--", "."],
      },
    ]);
  });

  it("keeps malformed skill metadata visible as unresolved", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, "invalid-skills");
    const skillPath = join(root, "fallback-name");
    await mkdir(skillPath, { recursive: true });
    await writeFile(
      join(skillPath, "SKILL.md"),
      "---\nname: [unterminated\n---\n# still a skill\n",
      "utf8",
    );

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        { kind: "user", path: root, agentId: "fixture", adapterId: null },
      ],
    });

    expect(inventory.installations).toHaveLength(1);
    expect(inventory.installations[0]).toMatchObject({
      status: "unresolved",
      skill: { name: "fallback-name", description: null },
      metadata: { generic: { frontmatter: "invalid" } },
    });
  });

  it("resolves bounded generic user and current-workspace roots", async () => {
    const environment = await createTestEnvironment();
    await createSkill(
      join(environment.home, ".agents", "skills", "user-default"),
      { name: "user-default" },
    );
    await createSkill(
      join(environment.workspace, ".agents", "skills", "workspace-default"),
      { name: "workspace-default" },
    );

    const inventory = await createScanner({
      homeDirectory: environment.home,
      workspaceDirectory: environment.workspace,
    }).scan({});

    expect(
      inventory.installations.map((installation) => [
        installation.skill.name,
        installation.classification,
      ]),
    ).toEqual([
      ["user-default", "active-installation"],
      ["workspace-default", "standalone-project-skill"],
    ]);
  });

  it("does not traverse through a linked discovery root", async () => {
    const environment = await createTestEnvironment();
    const targetRoot = join(environment.home, "outside-linked-root");
    const linkedRoot = join(environment.home, "linked-root");
    await createSkill(join(targetRoot, "nested", "escaped"), {
      name: "escaped",
    });
    await createDirectoryLink(targetRoot, linkedRoot);

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "user",
          path: linkedRoot,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    });

    expect(inventory.installations).toEqual([]);
  });

  it("deduplicates case aliases according to filesystem identity", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, "CaseSkills");
    const alias = join(environment.home, "caseskills");
    await createSkill(join(root, "only-once"), { name: "only-once" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [root, alias].map((path) => ({
        kind: "user" as const,
        path,
        agentId: "fixture",
        adapterId: null,
      })),
    });

    expect(inventory.installations).toHaveLength(1);
    expect(inventory.installations[0]?.skill.name).toBe("only-once");
  });

  it("is deterministic, bounded to requested roots, and zero-footprint", async () => {
    const environment = await createTestEnvironment();
    const knownRoot = join(environment.home, "known-skills");
    const outsideRoot = join(environment.home, "not-requested");
    await createSkill(join(knownRoot, "included"), { name: "included" });
    await createSkill(join(outsideRoot, "excluded"), { name: "excluded" });
    const protectedDirectories = [
      environment.config,
      environment.state,
      environment.cache,
      environment.temporary,
    ];
    const before = await Promise.all(
      protectedDirectories.map(snapshotDirectory),
    );
    const scanner = createScanner(unusedDefaultEnvironment(environment));
    const request = {
      roots: [
        {
          kind: "user" as const,
          path: knownRoot,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    };

    const first = await scanner.scan(request);
    const second = await scanner.scan(request);

    expect(stringifyModel(first)).toBe(stringifyModel(second));
    expect(first.installations.map((item) => item.skill.name)).toEqual([
      "included",
    ]);
    expect(stringifyModel(first)).not.toContain(outsideRoot);
    await expect(
      access(join(environment.state, "skill-cleaner")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      Promise.all(protectedDirectories.map(snapshotDirectory)),
    ).resolves.toEqual(before);
  });

  it("rejects ambiguous or unbounded root declarations", async () => {
    const environment = await createTestEnvironment();
    const scanner = createScanner(unusedDefaultEnvironment(environment));
    const sourceRoot = join(environment.workspace, "source-root");
    const nestedSourceRoot = join(sourceRoot, "nested-source");
    await createSkill(nestedSourceRoot, { name: "nested-source" });

    await expect(
      scanner.scan({
        roots: [
          {
            kind: "user",
            path: "relative-skills",
            agentId: "fixture",
            adapterId: null,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InventoryScanError);

    await expect(
      scanner.scan({
        roots: [
          {
            kind: "workspace",
            path: environment.home,
            workspacePath: environment.workspace,
            agentId: "fixture",
            adapterId: null,
          },
        ],
      }),
    ).rejects.toThrow(/outside its workspace/);

    await expect(
      scanner.scan({
        roots: [
          {
            kind: "source" as const,
            path: sourceRoot,
            agentId: null,
            scope: null,
            source: { id: "same-source", url: null },
            adapterId: null,
          },
          {
            kind: "source" as const,
            path: sourceRoot,
            agentId: null,
            scope: null,
            source: { id: "other-source", url: null },
            adapterId: null,
          },
        ],
      }),
    ).rejects.toThrow(/duplicate discovery root/);

    await expect(
      createInventoryScanner({
        now: () => new Date(Number.NaN),
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
      }).scan({ roots: [] }),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "inventory scanner clock returned an invalid date",
    });

    await expect(
      createInventoryScanner({
        now: () => fixedTime,
        environment: {
          ...unusedDefaultEnvironment(environment),
          stateDirectory: "relative-state",
        },
        commandRunner: unavailableCommandRunner,
      }).scan({ roots: [] }),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message:
        "inventory scanner requires absolute configured environment directories",
    });
  });

  it("treats a marked Codex runtime subtree as System Skills without touching the rest of the root", async () => {
    const environment = await createTestEnvironment();
    const codexHome = join(environment.home, ".codex");
    const codexSkills = join(codexHome, "skills");
    const systemRoot = join(codexSkills, ".system");
    await createSkill(join(codexSkills, "user-installed"), {
      name: "user-installed",
    });
    await createSkill(join(systemRoot, "imagegen"), { name: "imagegen" });
    await writeFile(
      join(systemRoot, ".codex-system-skills.marker"),
      "marker\n",
      "utf8",
    );

    const inventory = await createScanner({
      homeDirectory: environment.home,
      workspaceDirectory: join(environment.workspace, "unused-workspace"),
    }).scan({});

    expect(inventory.installations.map((item) => item.skill.name)).toEqual([
      "user-installed",
    ]);
    const finding = inventory.otherFindings.find(
      (item) => item.skill.name === "imagegen",
    );
    expect(finding).toMatchObject({
      classification: "system-skill",
      ownership: { kind: "agent-runtime", agentId: "codex" },
      protection: { system: { kind: "system-skill", agentId: "codex" } },
    });
  });

  it("leaves a Codex subtree ordinary when the marker is absent or is a link", async () => {
    const environment = await createTestEnvironment();
    const systemRoot = join(environment.home, ".codex", "skills", ".system");
    const decoy = join(environment.home, "decoy-marker");
    await createSkill(join(systemRoot, "imagegen"), { name: "imagegen" });
    await writeFile(decoy, "marker\n", "utf8");
    const scanRoot = {
      homeDirectory: environment.home,
      workspaceDirectory: join(environment.workspace, "unused-workspace"),
    };

    const withoutMarker = await createScanner(scanRoot).scan({});
    expect(withoutMarker.installations.map((item) => item.skill.name)).toEqual([
      "imagegen",
    ]);
    expect(withoutMarker.otherFindings).toEqual([]);

    await symlink(decoy, join(systemRoot, ".codex-system-skills.marker"));
    const withLinkedMarker = await createScanner(scanRoot).scan({});
    expect(
      withLinkedMarker.installations.map((item) => item.skill.name),
    ).toEqual(["imagegen"]);
    expect(withLinkedMarker.otherFindings).toEqual([]);
  });

  it("honors a configured Codex home when locating the marked runtime subtree", async () => {
    const environment = await createTestEnvironment();
    const codexHome = join(environment.root, "configured-codex");
    const systemRoot = join(codexHome, "skills", ".system");
    await createSkill(join(systemRoot, "imagegen"), { name: "imagegen" });
    await writeFile(
      join(systemRoot, ".codex-system-skills.marker"),
      "marker\n",
      "utf8",
    );

    const inventory = await createScanner({
      homeDirectory: environment.home,
      workspaceDirectory: join(environment.workspace, "unused-workspace"),
      agentHomeDirectories: { codex: codexHome },
    }).scan({});

    expect(inventory.installations).toEqual([]);
    expect(inventory.otherFindings).toHaveLength(1);
    expect(inventory.otherFindings[0]).toMatchObject({
      skill: { name: "imagegen" },
      classification: "system-skill",
    });
  });

  it("refuses a declared root that would widen removal inside a protective root", async () => {
    const environment = await createTestEnvironment();
    const vendorRoot = join(environment.home, "vendor");
    await createSkill(join(vendorRoot, "inner", "vendored"), {
      name: "vendored",
    });
    const catalog = await loadAdapters({
      localAdapterPaths: [
        await writeAdapter(environment, {
          schemaVersion: 1,
          id: "fixture.promoting-root",
          name: "Promoting root",
          platforms: [supportedPlatform()],
          roots: [
            {
              id: "root",
              kind: "user",
              agentId: "fixture",
              path: {
                default: { base: "home", segments: ["vendor", "inner"] },
              },
            },
          ],
        }),
      ],
      platform: supportedPlatform(),
      pathBases: adapterBases(environment),
    });

    await expect(
      createInventoryScanner({
        now: () => fixedTime,
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
        adapterCatalog: catalog,
      }).scan({
        roots: [
          {
            kind: "source",
            path: vendorRoot,
            agentId: null,
            scope: null,
            source: { id: "vendored-source", url: null },
            adapterId: null,
          },
        ],
      }),
    ).rejects.toThrow(/overlapping discovery roots/);
  });

  it("lets an explicitly supplied root reclassify a subtree of a protective root", async () => {
    const environment = await createTestEnvironment();
    const vendorRoot = join(environment.home, "vendor");
    const innerRoot = join(vendorRoot, "inner");
    await createSkill(join(innerRoot, "reclaimed"), { name: "reclaimed" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "source",
          path: vendorRoot,
          agentId: null,
          scope: null,
          source: { id: "vendored-source", url: null },
          adapterId: null,
        },
        { kind: "user", path: innerRoot, agentId: "fixture", adapterId: null },
      ],
    });

    expect(inventory.installations.map((item) => item.skill.name)).toEqual([
      "reclaimed",
    ]);
    expect(inventory.otherFindings).toEqual([]);
  });
});

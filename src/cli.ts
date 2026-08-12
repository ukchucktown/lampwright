#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AdapterTrustRequiredError, loadAdapters } from "./adapter/index.js";
import type { AdapterCatalog, AdapterTrustApproval } from "./adapter/types.js";
import {
  createFileAvailabilityExecutionAuditWriter,
  createExecutionModule,
  createFileExecutionAuditWriter,
  createFilePackageTrustStore,
  systemExecutionProcessRunner,
} from "./execution/index.js";
import type {
  AvailabilityIntent,
  AvailabilityPlan,
  AvailabilityReport,
} from "./availability/index.js";
import {
  createDisabledStorageModule,
  type DisabledEntry,
  type DisabledStorageModule,
} from "./disabled-storage/index.js";
import { nodeArtifactFileSystem } from "./filesystem/artifact-filesystem.js";
import { inspectGitProtection } from "./inventory/git-protection.js";
import {
  createInventoryScanner,
  defaultInventoryScanEnvironment,
} from "./inventory/index.js";
import { systemCommandRunner } from "./inventory/process.js";
import { stringifyModel } from "./model/json.js";
import type {
  ApprovalRequirement,
  ExecutionReport,
  Inventory,
  RemovalPlan,
} from "./model/types.js";
import { parseExecutionApprovals } from "./model/validation.js";
import {
  plan,
  planAvailability,
  PlanningError,
  resolveAvailabilitySelectors,
  resolveTargetSelectors,
} from "./planning/index.js";
import { createQuarantineModule } from "./quarantine/index.js";
import type {
  PurgePreview,
  QuarantineEntryId,
  QuarantineModule,
  RestorePreview,
} from "./quarantine/types.js";
import {
  createFileAdapterTrustStore,
  defaultLocalStateRoot,
} from "./state/index.js";
import { createNodeTuiTerminal, runTui } from "./tui/index.js";

interface PackageMetadata {
  readonly version: string;
}
export interface CliDependencies {
  readonly scan?: (adapterPaths: readonly string[]) => Promise<Inventory>;
  readonly execute?: (
    plan: RemovalPlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<ExecutionReport>;
  readonly quarantine?: QuarantineModule;
  readonly listDisabled?: () => Promise<readonly DisabledEntry[]>;
  readonly planAvailability?: (
    inventory: Inventory,
    disabledEntries: readonly DisabledEntry[],
    intent: AvailabilityIntent,
  ) => AvailabilityPlan;
  readonly executeAvailability?: (
    plan: AvailabilityPlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<AvailabilityReport>;
}
export interface CliResult {
  readonly exitCode: number;
  readonly output: unknown;
}

function readPackageMetadata(): PackageMetadata {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  )
    throw new Error("package.json does not contain a valid version");
  return value as PackageMetadata;
}

const help = `lampwright ${readPackageMetadata().version}

Discover and safely manage AI agent skills.

Usage:
  lampwright
  lampwright scan [--json] [--adapter <path>]
  lampwright disable <selector...> [--dry-run] [--yes] [--force] [--json] [--adapter <path>]
  lampwright enable <selector...> [--dry-run] [--yes] [--json] [--adapter <path>]
  lampwright remove <selector...> [--all] [--include-plugins] [--dry-run] [--yes] [--force] [--brute-force] [--json] [--adapter <path>]
  lampwright restore <entry-id> [--dry-run] [--yes] [--json]
  lampwright purge <entry-id...> [--dry-run] [--yes] [--json]

Selectors:
  Availability: installation:<installation-id>  logical-skill:<logical-skill-id>
                group:<group-id>  plugin:<plugin-boundary-id>
  Enable only:  disabled-entry:<entry-id>
  Removal also: source:<source-id>  plugin:<plugin-boundary-id>

Exit codes: 0 succeeded; 1 operational failure; 2 invalid usage; 3 blocked or confirmation required.

Options:
  --json                              Emit deterministic JSON
  --dry-run                           Return a complete plan without mutation
  --yes                               Grant ordinary confirmation
  --force                             Override dependency or ambiguity blocks
  --brute-force                       Select the recoverable fallback plan
  --all                               Select all ordinary Installations
  --include-plugins                   Include Plugins with --all
  --adapter <path>                    Load a local JSONC adapter
  --trust-adapter <id>:<sha256>       Approve exact local adapter content
  --trust-package npx:<pkg>@<version>:<adapter-sha256>
                                      Approve exact ephemeral package use
  -h, --help                          Show help
  -v, --version                       Show version
`;

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  let parsed: Parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error: unknown) {
    return failure(
      "invalid-usage",
      error instanceof Error ? error.message : String(error),
      2,
    );
  }
  try {
    if (parsed.command === "help") return { exitCode: 0, output: help };
    if (parsed.command === "version")
      return { exitCode: 0, output: `${readPackageMetadata().version}\n` };
    if (parsed.command === "scan")
      return result(
        (
          await scanWithContext(
            parsed.adapters,
            parsed.adapterTrusts,
            dependencies,
          )
        ).inventory,
        0,
      );
    if (parsed.command === "remove") return await remove(parsed, dependencies);
    if (parsed.command === "disable" || parsed.command === "enable")
      return await availability(parsed, dependencies);
    if (parsed.command === "restore" || parsed.command === "purge")
      return await quarantineCommand(parsed, dependencies);
    return failure("invalid-usage", "unknown command", 2);
  } catch (error: unknown) {
    if (error instanceof AdapterTrustRequiredError)
      return result(
        {
          schemaVersion: 1,
          kind: "trust-required",
          requirements: error.requirements,
        },
        3,
      );
    if (error instanceof PlanningError) {
      const invalidUsage =
        error.code === "invalid-intent" || error.code === "overlapping-targets";
      return failure(
        invalidUsage ? "invalid-usage" : "target-not-found",
        error.message,
        invalidUsage ? 2 : 3,
      );
    }
    return failure(
      "operational-error",
      error instanceof Error ? error.message : String(error),
      1,
    );
  }
}

type Parsed = {
  readonly command:
    | "help"
    | "version"
    | "scan"
    | "disable"
    | "enable"
    | "remove"
    | "restore"
    | "purge";
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly force: boolean;
  readonly bruteForce: boolean;
  readonly all: boolean;
  readonly includePlugins: boolean;
  readonly adapters: readonly string[];
  readonly adapterTrusts: readonly AdapterTrustApproval[];
  readonly packageTrusts: readonly ApprovalRequirement[];
  readonly values: readonly string[];
};

function parseArguments(argv: readonly string[]): Parsed {
  const values: string[] = [],
    adapters: string[] = [],
    adapterTrusts: AdapterTrustApproval[] = [];
  const packageTrusts: ApprovalRequirement[] = [];
  let dryRun = false,
    yes = false,
    force = false,
    bruteForce = false,
    all = false,
    includePlugins = false;
  let command: Parsed["command"] = "help";
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === undefined) {
    if (argv.length > 1)
      throw new Error(`${String(first)} accepts no arguments`);
    return {
      command,
      dryRun,
      yes,
      force,
      bruteForce,
      all,
      includePlugins,
      adapters,
      adapterTrusts,
      packageTrusts,
      values,
    };
  }
  if (first === "--version" || first === "-v") {
    if (argv.length > 1) throw new Error(`${first} accepts no arguments`);
    return {
      command: "version",
      dryRun,
      yes,
      force,
      bruteForce,
      all,
      includePlugins,
      adapters,
      adapterTrusts,
      packageTrusts,
      values,
    };
  }
  if (
    ["scan", "disable", "enable", "remove", "restore", "purge"].includes(first)
  )
    command = first as Parsed["command"];
  else throw new Error(`unknown command: ${first}`);
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--json") continue;
    else if (value === "--dry-run") dryRun = true;
    else if (value === "--yes") yes = true;
    else if (value === "--force") force = true;
    else if (value === "--brute-force") bruteForce = true;
    else if (value === "--all") all = true;
    else if (value === "--include-plugins") includePlugins = true;
    else if (value === "--adapter") {
      const path = argv[++index];
      if (path === undefined || path.startsWith("-"))
        throw new Error("--adapter requires a path");
      adapters.push(path);
    } else if (value === "--trust-adapter") {
      adapterTrusts.push(parseAdapterTrust(argv[++index]));
    } else if (value === "--trust-package") {
      packageTrusts.push(parsePackageTrust(argv[++index]));
    } else if (value.startsWith("-"))
      throw new Error(`unknown option: ${value}`);
    else values.push(value);
  }
  if (
    command === "scan" &&
    (values.length > 0 ||
      all ||
      includePlugins ||
      dryRun ||
      yes ||
      force ||
      bruteForce ||
      packageTrusts.length > 0)
  )
    throw new Error("scan accepts only --json, --adapter, and --trust-adapter");
  if (
    (command === "restore" || command === "purge") &&
    (adapters.length > 0 ||
      adapterTrusts.length > 0 ||
      packageTrusts.length > 0 ||
      all ||
      includePlugins ||
      force ||
      bruteForce)
  )
    throw new Error(`${command} does not accept removal options`);
  if (command === "restore" && values.length !== 1)
    throw new Error("restore requires exactly one quarantine entry ID");
  if (command === "purge" && values.length === 0)
    throw new Error("purge requires at least one quarantine entry ID");
  if (command === "remove" && !all && values.length === 0)
    throw new Error("remove requires a selector or --all");
  if (command === "remove" && all && values.length > 0)
    throw new Error("remove cannot combine selectors with --all");
  if (includePlugins && !all)
    throw new Error("--include-plugins requires --all");
  if (bruteForce && command !== "remove")
    throw new Error("--brute-force is only valid for remove");
  if ((command === "disable" || command === "enable") && values.length === 0)
    throw new Error(`${command} requires at least one selector`);
  if (
    (command === "disable" || command === "enable") &&
    (all || includePlugins || bruteForce || packageTrusts.length > 0)
  )
    throw new Error(`${command} does not accept removal-only options`);
  if (command === "enable" && force)
    throw new Error("enable does not accept --force");
  return {
    command,
    dryRun,
    yes,
    force,
    bruteForce,
    all,
    includePlugins,
    adapters,
    adapterTrusts,
    packageTrusts,
    values,
  };
}

async function remove(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const scanned = await scanWithContext(
    args.adapters,
    args.adapterTrusts,
    dependencies,
  );
  const inventory = scanned.inventory;
  const targets = args.all
    ? []
    : resolveTargetSelectors(inventory, args.values);
  const removalPlan = plan(
    inventory,
    args.all
      ? {
          kind: "all",
          includePlugins: args.includePlugins,
          force: args.force,
          mode: args.bruteForce ? "brute-force" : "managed-first",
        }
      : {
          kind: "targets",
          targets,
          force: args.force,
          mode: args.bruteForce ? "brute-force" : "managed-first",
        },
  );
  if (args.dryRun)
    return result(
      { schemaVersion: 1, kind: "removal-plan", plan: removalPlan },
      removalPlan.blocks.length === 0 ? 0 : 3,
    );
  if (removalPlan.blocks.length > 0)
    return result(
      { schemaVersion: 1, kind: "removal-plan", plan: removalPlan },
      3,
    );
  if (!args.yes)
    return result(
      {
        schemaVersion: 1,
        kind: "confirmation-required",
        operation: "remove",
        plan: removalPlan,
      },
      3,
    );
  const approvals = [
    ...grantsFor(removalPlan, args),
    ...scanned.newAdapterTrusts.map((approval): ApprovalRequirement => ({
      kind: "adapter-trust",
      adapterId: approval.adapterId,
      contentHash: approval.contentHash,
    })),
    ...args.packageTrusts,
  ];
  const report =
    dependencies.execute === undefined
      ? await productionExecute(
          removalPlan,
          args.adapters,
          args.adapterTrusts,
          scanned.newAdapterTrusts,
          approvals,
        )
      : await dependencies.execute(removalPlan, approvals);
  return result(
    { schemaVersion: 1, kind: "execution-report", report },
    executionExitCode(report),
  );
}

async function availability(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const operation = args.command as "disable" | "enable";
  const scanned = await scanWithContext(
    args.adapters,
    args.adapterTrusts,
    dependencies,
  );
  const disabledStorage = availabilityStorage(dependencies);
  const disabledEntries = await disabledStorage.list();
  const targets = resolveAvailabilitySelectors(
    scanned.inventory,
    disabledEntries,
    operation,
    args.values,
  );
  const planner = dependencies.planAvailability ?? planAvailability;
  const availabilityPlan = planner(scanned.inventory, disabledEntries, {
    operation,
    targets,
    force: args.force,
  });
  const planEnvelope = {
    schemaVersion: 1 as const,
    kind: "availability-plan" as const,
    plan: availabilityPlan,
  };
  if (args.dryRun || availabilityPlan.blocks.length > 0)
    return result(planEnvelope, availabilityPlan.blocks.length === 0 ? 0 : 3);
  if (!args.yes)
    return result(
      {
        schemaVersion: 1,
        kind: "confirmation-required",
        operation,
        plan: availabilityPlan,
      },
      3,
    );
  const approvals = [
    ...availabilityGrants(availabilityPlan),
    ...scanned.newAdapterTrusts.map((approval): ApprovalRequirement => ({
      kind: "adapter-trust",
      adapterId: approval.adapterId,
      contentHash: approval.contentHash,
    })),
  ];
  const report =
    dependencies.executeAvailability === undefined
      ? await productionExecuteAvailability(
          availabilityPlan,
          args.adapters,
          args.adapterTrusts,
          scanned.newAdapterTrusts,
          approvals,
          disabledStorage.module,
        )
      : await dependencies.executeAvailability(availabilityPlan, approvals);
  return result(
    {
      schemaVersion: 1,
      kind: "availability-report",
      operation,
      disabledEntryIds: suspendedEntryIds(availabilityPlan, report),
      report,
    },
    executionExitCode(report),
  );
}

function availabilityGrants(
  availabilityPlan: AvailabilityPlan,
): readonly ApprovalRequirement[] {
  return availabilityPlan.actions
    .flatMap((action) => action.approvals)
    .filter(
      (approval, index, all) =>
        all.findIndex(
          (candidate) =>
            stringifyModel(candidate, 0) === stringifyModel(approval, 0),
        ) === index,
    );
}

function suspendedEntryIds(
  availabilityPlan: AvailabilityPlan,
  report: AvailabilityReport,
): readonly string[] {
  const successful = new Set(
    report.actionResults
      .filter(
        (result) =>
          result.status === "succeeded" || result.status === "unchanged",
      )
      .map((result) => result.actionId),
  );
  return [
    ...new Set(
      availabilityPlan.actions
        .filter(
          (action) =>
            action.kind === "suspended-disable" && successful.has(action.id),
        )
        .flatMap((action) => {
          const result = report.actionResults.find(
            (candidate) => candidate.actionId === action.id,
          );
          return result !== undefined &&
            (result.status === "succeeded" || result.status === "unchanged") &&
            typeof result.details.entryId === "string"
            ? [result.details.entryId]
            : [];
        }),
    ),
  ].sort();
}

function availabilityStorage(dependencies: CliDependencies): {
  readonly list: () => Promise<readonly DisabledEntry[]>;
  readonly module: DisabledStorageModule | undefined;
} {
  if (dependencies.listDisabled !== undefined)
    return { list: dependencies.listDisabled, module: undefined };
  if (
    dependencies.scan !== undefined ||
    dependencies.planAvailability !== undefined ||
    dependencies.executeAvailability !== undefined
  )
    throw new Error(
      "listDisabled must be injected with Availability CLI dependencies",
    );
  const module = createProductionDisabledStorage();
  return { list: () => module.list(), module };
}

async function quarantineCommand(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const quarantine = dependencies.quarantine ?? createQuarantineModule();
  const entries = await quarantine.list();
  const selected = entries.filter((entry) => args.values.includes(entry.id));
  const missingEntryIds = args.values.filter(
    (id) => !selected.some((entry) => entry.id === id),
  );
  const preview =
    missingEntryIds.length > 0
      ? null
      : args.command === "restore"
        ? await quarantine.previewRestore(selected[0]!)
        : await quarantine.previewPurge({
            kind: "entries",
            entryIds: quarantineEntryIds(args.values),
          });
  const quarantinePlan = {
    schemaVersion: 1 as const,
    kind: "quarantine-plan" as const,
    command: args.command,
    entries: selected,
    missingEntryIds,
    preview,
  };
  const previewExitCode = quarantinePlanExitCode(quarantinePlan);
  if (args.dryRun || previewExitCode !== 0)
    return result(quarantinePlan, previewExitCode);
  if (!args.yes)
    return result(
      {
        schemaVersion: 1,
        kind: "confirmation-required",
        operation: args.command,
        plan: quarantinePlan,
      },
      3,
    );
  if (args.command === "restore") {
    const output = await quarantine.restore(selected[0]!);
    return result(
      { schemaVersion: 1, kind: "restore-result", result: output },
      isBlocked(output) ? 3 : 0,
    );
  }
  const output = await quarantine.purge({
    kind: "entries",
    entryIds: quarantineEntryIds(args.values),
  });
  return result(
    { schemaVersion: 1, kind: "purge-result", result: output },
    purgeExitCode(output),
  );
}

function grantsFor(
  removalPlan: RemovalPlan,
  args: Parsed,
): readonly ApprovalRequirement[] {
  return removalPlan.actions
    .flatMap((action) => action.approvals)
    .filter(
      (approval, index, all) =>
        all.findIndex(
          (candidate) =>
            stringifyModel(candidate, 0) === stringifyModel(approval, 0),
        ) === index,
    )
    .filter(
      (approval) =>
        approval.kind !== "adapter-trust" &&
        approval.kind !== "package-trust" &&
        (approval.kind !== "brute-force-confirmation" || args.bruteForce),
    );
}
interface ScanContext {
  readonly inventory: Inventory;
  readonly newAdapterTrusts: readonly AdapterTrustApproval[];
}

async function scanWithContext(
  adapterPaths: readonly string[],
  adapterTrusts: readonly AdapterTrustApproval[],
  dependencies: CliDependencies,
): Promise<ScanContext> {
  if (dependencies.scan !== undefined)
    return {
      inventory: await dependencies.scan(adapterPaths),
      newAdapterTrusts: [],
    };
  const home = homedir();
  const workspace = process.cwd();
  const request = {
    localAdapterPaths: adapterPaths,
    pathBases: {
      home,
      workspace,
      config: process.env.XDG_CONFIG_HOME || join(home, ".config"),
      state: process.env.XDG_STATE_HOME || join(home, ".local", "state"),
      cache: process.env.XDG_CACHE_HOME || join(home, ".cache"),
      temporary: tmpdir(),
    },
  };
  const store = createFileAdapterTrustStore(defaultLocalStateRoot());
  let catalog: AdapterCatalog;
  try {
    catalog = await loadAdapters({ ...request, approvals: adapterTrusts });
  } catch (error: unknown) {
    if (!(error instanceof AdapterTrustRequiredError)) throw error;
    const stored = await Promise.all(
      error.requirements.map(async (requirement) => ({
        adapterId: requirement.adapterId,
        contentHash: requirement.contentHash,
        trusted: await store.isTrusted({
          adapterId: requirement.adapterId,
          contentHash: requirement.contentHash,
        }),
      })),
    );
    const approvals = [
      ...adapterTrusts,
      ...stored
        .filter((item) => item.trusted)
        .map(({ adapterId, contentHash }) => ({ adapterId, contentHash })),
    ];
    catalog = await loadAdapters({ ...request, approvals });
  }
  const inventory = await createInventoryScanner({
    now: () => new Date(),
    environment: defaultInventoryScanEnvironment(),
    commandRunner: systemCommandRunner,
    adapterCatalog: catalog,
  }).scan({});
  return {
    inventory,
    newAdapterTrusts: adapterTrusts.filter((approval) =>
      catalog.adapters.some(
        (adapter) =>
          adapter.id === approval.adapterId &&
          adapter.source.kind === "local" &&
          adapter.source.contentHash === approval.contentHash &&
          adapter.trust.kind === "approved",
      ),
    ),
  };
}

async function scan(
  adapterPaths: readonly string[],
  adapterTrusts: readonly AdapterTrustApproval[],
): Promise<Inventory> {
  return (await scanWithContext(adapterPaths, adapterTrusts, {})).inventory;
}
async function productionExecute(
  removalPlan: RemovalPlan,
  adapterPaths: readonly string[],
  adapterTrusts: readonly AdapterTrustApproval[],
  newAdapterTrusts: readonly AdapterTrustApproval[],
  approvals: readonly ApprovalRequirement[],
): Promise<ExecutionReport> {
  const stateRoot = defaultLocalStateRoot();
  const adapterTrustStore = createFileAdapterTrustStore(stateRoot);
  for (const approval of newAdapterTrusts)
    await adapterTrustStore.trust(approval);
  const report = await createExecutionModule({
    scan: () => scan(adapterPaths, adapterTrusts),
    replan: plan,
    quarantine: createQuarantineModule(),
    processRunner: systemExecutionProcessRunner,
    inspectGitProtection: (path, artifactType) =>
      inspectGitProtection(
        path,
        artifactType?.kind === "directory",
        systemCommandRunner,
      ),
    auditWriter: createFileExecutionAuditWriter(stateRoot),
    packageTrustStore: createFilePackageTrustStore(stateRoot),
    now: () => new Date(),
    stateRoot,
  }).execute(removalPlan, { grants: approvals });
  return report;
}

function createProductionDisabledStorage(): DisabledStorageModule {
  const stateRoot = defaultLocalStateRoot();
  return createDisabledStorageModule({
    stateRoot,
    now: () => new Date(),
    createId: randomUUID,
    fileSystem: nodeArtifactFileSystem,
    inspectGitProtection: (path, artifactType) =>
      inspectGitProtection(
        path,
        artifactType.kind === "directory",
        systemCommandRunner,
      ),
  });
}

async function productionExecuteAvailability(
  availabilityPlan: AvailabilityPlan,
  adapterPaths: readonly string[],
  adapterTrusts: readonly AdapterTrustApproval[],
  newAdapterTrusts: readonly AdapterTrustApproval[],
  approvals: readonly ApprovalRequirement[],
  providedStorage: DisabledStorageModule | undefined,
): Promise<AvailabilityReport> {
  if (providedStorage === undefined)
    throw new Error(
      "executeAvailability must be injected when listDisabled is injected",
    );
  const stateRoot = defaultLocalStateRoot();
  const adapterTrustStore = createFileAdapterTrustStore(stateRoot);
  for (const approval of newAdapterTrusts)
    await adapterTrustStore.trust(approval);
  return createExecutionModule({
    scan: () => scan(adapterPaths, adapterTrusts),
    replan: plan,
    quarantine: createQuarantineModule(),
    processRunner: systemExecutionProcessRunner,
    inspectGitProtection: (path, artifactType) =>
      inspectGitProtection(
        path,
        artifactType?.kind === "directory",
        systemCommandRunner,
      ),
    auditWriter: createFileExecutionAuditWriter(stateRoot),
    packageTrustStore: createFilePackageTrustStore(stateRoot),
    now: () => new Date(),
    stateRoot,
    disabledStorage: providedStorage,
    replanAvailability: planAvailability,
    availabilityAuditWriter:
      createFileAvailabilityExecutionAuditWriter(stateRoot),
  }).executeAvailability(availabilityPlan, { grants: approvals });
}
function parseAdapterTrust(value: string | undefined): AdapterTrustApproval {
  const match = value?.match(/^([^\s]+):([a-f\d]{64})$/);
  if (match === undefined || match === null)
    throw new Error("--trust-adapter requires adapter-id:sha256");
  return { adapterId: match[1]!, contentHash: match[2]! };
}
function parsePackageTrust(value: string | undefined): ApprovalRequirement {
  const hashSeparator = value?.lastIndexOf(":") ?? -1;
  const tuple = value?.slice(0, hashSeparator) ?? "";
  const hash = value?.slice(hashSeparator + 1) ?? "";
  const versionSeparator = tuple.lastIndexOf("@");
  const runnerSeparator = tuple.indexOf(":");
  const runner = tuple.slice(0, runnerSeparator);
  const packageName = tuple.slice(runnerSeparator + 1, versionSeparator);
  const packageVersion = tuple.slice(versionSeparator + 1);
  if (
    runner !== "npx" ||
    versionSeparator <= runnerSeparator + 1 ||
    !/^[a-f\d]{64}$/.test(hash)
  )
    throw invalidPackageTrust();
  try {
    const approval = parseExecutionApprovals({
      grants: [
        {
          kind: "package-trust",
          runner: "npx",
          packageName,
          packageVersion,
          adapterHash: hash,
        },
      ],
    }).grants[0];
    if (approval?.kind === "package-trust") return approval;
  } catch {
    throw invalidPackageTrust();
  }
  throw invalidPackageTrust();
}
function invalidPackageTrust(): Error {
  return new Error(
    "--trust-package requires npx:package@version:adapter-sha256",
  );
}
function quarantineEntryIds(
  values: readonly string[],
): readonly QuarantineEntryId[] {
  return values.map((value) => value as QuarantineEntryId);
}
function quarantinePlanExitCode(plan: {
  readonly missingEntryIds: readonly string[];
  readonly preview: RestorePreview | PurgePreview | null;
}): number {
  if (plan.missingEntryIds.length > 0 || plan.preview === null) return 3;
  if ("status" in plan.preview)
    return plan.preview.status === "blocked" ? 3 : 0;
  return plan.preview.entries.some((entry) => entry.status !== "would-purge")
    ? 3
    : 0;
}
function purgeExitCode(output: unknown): number {
  if (
    typeof output !== "object" ||
    output === null ||
    !("entries" in output) ||
    !Array.isArray(output.entries)
  )
    return 1;
  return output.entries.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "status" in entry &&
      entry.status !== "purged",
  )
    ? 3
    : 0;
}
function executionExitCode(output: unknown): number {
  if (typeof output !== "object" || output === null || !("status" in output)) {
    return 1;
  }
  return output.status === "succeeded"
    ? 0
    : output.status === "blocked"
      ? 3
      : 1;
}
function isBlocked(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    output.status === "blocked"
  );
}
function result(output: unknown, exitCode: number): CliResult {
  return { output, exitCode };
}
function failure(code: string, message: string, exitCode: number): CliResult {
  return {
    exitCode,
    output: { schemaVersion: 1, kind: "error", code, message },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const quarantine = createQuarantineModule();
    const disabledStorage = createProductionDisabledStorage();
    const outcome = await runTui(
      {
        scan: async () => (await scanWithContext([], [], {})).inventory,
        plan,
        execute: (removalPlan, approvals) =>
          productionExecute(removalPlan, [], [], [], approvals),
        quarantine,
        listDisabled: () => disabledStorage.list(),
        planAvailability,
        executeAvailability: (availabilityPlan, approvals) =>
          productionExecuteAvailability(
            availabilityPlan,
            [],
            [],
            [],
            approvals,
            disabledStorage,
          ),
      },
      createNodeTuiTerminal(),
    );
    if (outcome.status === "failed") {
      process.stderr.write(`lampwright: ${outcome.message}\n`);
      process.exitCode = 1;
    } else if (outcome.status === "completed") {
      process.exitCode = executionExitCode(outcome.report);
    } else process.exitCode = 0;
    return;
  }
  const result = await runCli(argv);
  const json = argv.includes("--json");
  const output = formatCliOutput(result.output, json);
  (json || result.exitCode === 0 ? process.stdout : process.stderr).write(
    output,
  );
  process.exitCode = result.exitCode;
}
export function formatCliOutput(output: unknown, json: boolean): string {
  if (typeof output === "string") return output;
  return json ? `${stringifyModel(output)}\n` : human(output);
}
function human(output: unknown): string {
  if (typeof output === "string") return output;
  if (!isRecord(output)) return `${String(output)}\n`;
  if (isInventory(output)) {
    return `Found ${output.installations.length} Installation(s), ${output.logicalSkills.length} Logical Skill(s), ${output.plugins.length} Plugin(s), and ${output.otherFindings.length} other finding(s).\n`;
  }
  if (output.kind === "error")
    return `${String(output.code)}: ${String(output.message)}\n`;
  if (output.kind === "trust-required") {
    const requirements = Array.isArray(output.requirements)
      ? output.requirements.filter(isRecord)
      : [];
    return `Local adapter trust is required:\n${requirements
      .map(
        (requirement) =>
          `- ${String(requirement.adapterId)}:${String(requirement.contentHash)}`,
      )
      .join(
        "\n",
      )}\nReview the adapter, then re-run with --trust-adapter <id>:<sha256>.\n`;
  }
  if (output.kind === "removal-plan") return humanRemovalPlan(output.plan);
  if (output.kind === "availability-plan")
    return humanAvailabilityPlan(output.plan);
  if (output.kind === "confirmation-required")
    return `${humanPlan(output.plan)}Confirmation required for ${String(output.operation)}. ${output.operation === "remove" ? "Supply every approval flag shown above before executing." : "Re-run with --yes after reviewing this plan."}\n`;
  if (output.kind === "execution-report" && isRecord(output.report)) {
    const report = output.report;
    const fallbackCount = Array.isArray(report.fallbackPlans)
      ? report.fallbackPlans.length
      : 0;
    const skipped = Array.isArray(report.actionResults)
      ? report.actionResults.filter(
          (result) => isRecord(result) && result.status === "skipped",
        )
      : [];
    return `Removal ${String(report.status)}.${fallbackCount > 0 ? ` ${fallbackCount} separately confirmed brute-force fallback plan(s) are available.` : ""}${skipped.length > 0 ? " Review the dry-run plan and supply its missing approval flags before retrying." : ""}\n`;
  }
  if (output.kind === "availability-report" && isRecord(output.report)) {
    const entryIds = Array.isArray(output.disabledEntryIds)
      ? output.disabledEntryIds.map(String)
      : [];
    return `Availability ${String(output.operation)} ${String(output.report.status)}.${entryIds.length > 0 ? ` Enable later with ${entryIds.map((id) => `disabled-entry:${id}`).join(", ")}.` : ""}\n`;
  }
  if (output.kind === "quarantine-plan") return humanQuarantinePlan(output);
  if (output.kind === "restore-result" && isRecord(output.result))
    return output.result.status === "blocked"
      ? `Restore blocked: ${String(output.result.reason)} at ${String(output.result.path)}.\n`
      : `Restored quarantine entry ${String(output.result.entryId)} to ${String(output.result.destination)}.\n`;
  if (output.kind === "purge-result" && isRecord(output.result)) {
    const entries = Array.isArray(output.result.entries)
      ? output.result.entries
      : [];
    const blocked = entries.filter(
      (entry) => isRecord(entry) && entry.status === "blocked",
    );
    const purged = entries.filter(
      (entry) => isRecord(entry) && entry.status === "purged",
    );
    const unchanged = entries.length - purged.length - blocked.length;
    return `Purged ${purged.length} quarantine entry(s)${unchanged > 0 ? `; ${unchanged} already absent` : ""}${blocked.length > 0 ? `; ${blocked.length} blocked by integrity checks` : ""}.\n`;
  }
  return `${stringifyModel(output)}\n`;
}

function humanPlan(plan: unknown): string {
  if (!isRecord(plan)) return "";
  if (plan.kind === "quarantine-plan") return humanQuarantinePlan(plan);
  if (
    isRecord(plan.intent) &&
    (plan.intent.operation === "disable" || plan.intent.operation === "enable")
  )
    return humanAvailabilityPlan(plan);
  return humanRemovalPlan(plan);
}

function humanAvailabilityPlan(plan: unknown): string {
  if (!isRecord(plan)) return "Availability plan unavailable.\n";
  const operation = isRecord(plan.intent)
    ? String(plan.intent.operation)
    : "change";
  const targets = Array.isArray(plan.targets) ? plan.targets.length : 0;
  const actions = Array.isArray(plan.actions) ? plan.actions.length : 0;
  const blocks = Array.isArray(plan.blocks) ? plan.blocks.filter(isRecord) : [];
  const blockSummary =
    blocks.length === 0
      ? ""
      : `${blocks.map((block) => `- ${describeBlock(block)}`).join("\n")}\nResolve the blocks or use --force only where the plan marks a block overridable.\n`;
  return `Availability ${operation} plan: ${targets} target(s), ${actions} action(s), ${blocks.length} block(s).\n${blockSummary}${approvalGuidance(plan)}`;
}

function humanRemovalPlan(plan: unknown): string {
  if (!isRecord(plan)) return "Removal plan unavailable.\n";
  const targets = Array.isArray(plan.targets) ? plan.targets.length : 0;
  const actions = Array.isArray(plan.actions) ? plan.actions.length : 0;
  const blocks = Array.isArray(plan.blocks) ? plan.blocks.filter(isRecord) : [];
  const summary = `Removal plan: ${targets} target(s), ${actions} action(s), ${blocks.length} block(s).\n`;
  const blockSummary =
    blocks.length === 0
      ? ""
      : `${blocks
          .map((block) => `- ${describeBlock(block)}`)
          .join(
            "\n",
          )}\nResolve the blocks or use --force only where the plan marks a block overridable.\n`;
  return `${summary}${blockSummary}${approvalGuidance(plan)}`;
}

function approvalGuidance(plan: Record<string, unknown>): string {
  const actions = Array.isArray(plan.actions)
    ? plan.actions.filter(isRecord)
    : [];
  const approvals = actions.flatMap((action) =>
    Array.isArray(action.approvals) ? action.approvals.filter(isRecord) : [],
  );
  const guidance: string[] = [];
  if (
    approvals.some((approval) => approval.kind === "brute-force-confirmation")
  )
    guidance.push(
      "Separate fallback approval: re-run with --brute-force --yes.",
    );
  else if (approvals.some((approval) => approval.kind === "confirmation"))
    guidance.push("Approval: re-run with --yes.");
  for (const approval of approvals.filter(
    (candidate) => candidate.kind === "package-trust",
  )) {
    guidance.push(
      `Package trust: --trust-package ${String(approval.runner)}:${String(approval.packageName)}@${String(approval.packageVersion)}:${String(approval.adapterHash)}`,
    );
  }
  return guidance.length === 0 ? "" : `${[...new Set(guidance)].join("\n")}\n`;
}

function humanQuarantinePlan(plan: Record<string, unknown>): string {
  const missing = Array.isArray(plan.missingEntryIds)
    ? plan.missingEntryIds.map(String)
    : [];
  if (missing.length > 0)
    return `${String(plan.command)} blocked; quarantine entries were not found: ${missing.join(", ")}.\n`;
  const preview = isRecord(plan.preview) ? plan.preview : null;
  if (preview === null) return `${String(plan.command)} preview unavailable.\n`;
  if ("status" in preview)
    return preview.status === "blocked"
      ? `Restore blocked: ${String(preview.reason)} at ${String(preview.path)}.\n`
      : `Restore would place ${String(preview.entryId)} at ${String(preview.destination)}.\n`;
  const entries = Array.isArray(preview.entries) ? preview.entries : [];
  const blocked = entries.filter(
    (entry) => isRecord(entry) && entry.status === "blocked",
  );
  return `Purge plan: ${entries.length} quarantine entry(s), ${blocked.length} block(s).\n`;
}

function describeBlock(block: Record<string, unknown>): string {
  const location = typeof block.path === "string" ? ` at ${block.path}` : "";
  const reason = typeof block.reason === "string" ? `: ${block.reason}` : "";
  const subject =
    typeof block.pluginId === "string" ? ` ${block.pluginId}` : "";
  const override =
    block.overridable === true
      ? " (overridable with --force)"
      : " (not overridable)";
  return `${String(block.kind)}${subject}${location}${reason}${override}`;
}

function isInventory(
  value: Record<string, unknown>,
): value is Inventory & Record<string, unknown> {
  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.scannedAt === "string" &&
    Array.isArray(value.installations) &&
    Array.isArray(value.otherFindings) &&
    Array.isArray(value.logicalSkills) &&
    Array.isArray(value.plugins)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
if (isMainModule(import.meta.url, process.argv[1])) void main();

function isMainModule(
  moduleUrl: string,
  entryPath: string | undefined,
): boolean {
  if (entryPath === undefined) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

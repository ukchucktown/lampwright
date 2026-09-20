#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AdapterTrustRequiredError, loadAdapters } from "./adapter/index.js";
import type { AdapterCatalog, AdapterTrustApproval } from "./adapter/types.js";
import {
  createFileAvailabilityExecutionAuditWriter,
  createExecutionModule,
  createFileExecutionAuditWriter,
  createFilePackageTrustStore,
  createFileUpdateExecutionAuditWriter,
  createFileSessionSetupExecutionAuditWriter,
  createBuiltInSessionSetupConfigurationWriter,
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
  createSessionSetupScanner,
  defaultInventoryScanEnvironment,
} from "./inventory/index.js";
import type {
  SessionSetupPlan,
  SessionSetupReport,
  SessionSetupSnapshot,
  SessionSetupTarget,
  SessionSetupTargetRef,
  SetupHarnessId,
} from "./session-setup/types.js";
import {
  executeSessionSetup,
  planSessionSetup,
} from "./session-setup/index.js";
import { systemCommandRunner } from "./inventory/process.js";
import { stringifyModel } from "./model/json.js";
import type {
  ApprovalRequirement,
  ExecutionReport,
  Inventory,
  RemovalPlan,
} from "./model/types.js";
import { parseExecutionApprovals } from "./model/validation.js";
import type { UpdateIntent, UpdatePlan, UpdateReport } from "./update/index.js";
import {
  plan,
  planAvailability,
  planUpdate,
  PlanningError,
  resolveAvailabilitySelectors,
  resolveTargetSelectors,
  resolveUpdateSelector,
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
  readonly planUpdate?: (
    inventory: Inventory,
    intent: UpdateIntent,
  ) => UpdatePlan;
  readonly executeUpdate?: (
    plan: UpdatePlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<UpdateReport>;
  readonly scanSessionSetup?: (request: {
    readonly workspace: { readonly path: string };
    readonly harnessId?: SetupHarnessId;
  }) => Promise<SessionSetupSnapshot>;
  readonly planSessionSetup?: (
    snapshot: SessionSetupSnapshot,
    intent: SessionSetupPlan["intent"],
  ) => SessionSetupPlan;
  readonly executeSessionSetup?: (
    plan: SessionSetupPlan,
    approvals: {
      readonly grants: readonly import("./session-setup/types.js").SetupApproval[];
    },
  ) => Promise<SessionSetupReport>;
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
  lampwright scan --session-setup [--harness <id>] [--workspace <path>] [--json]
  lampwright disable setup:<target-id> [--harness <id>] [--workspace <path>] [--dry-run] [--yes] [--json]
  lampwright enable setup:<target-id> [--harness <id>] [--workspace <path>] [--dry-run] [--yes] [--json]
  lampwright disable <selector...> [--dry-run] [--yes] [--force] [--json] [--adapter <path>]
  lampwright enable <selector...> [--dry-run] [--yes] [--json] [--adapter <path>]
  lampwright update <selector> [--dry-run] [--yes] [--json] [--adapter <path>]
  lampwright remove <selector...> [--all] [--include-plugins] [--dry-run] [--yes] [--force] [--brute-force] [--json] [--adapter <path>]
  lampwright restore <entry-id> [--dry-run] [--yes] [--json]
  lampwright purge <entry-id...> [--dry-run] [--yes] [--json]

Selectors:
  Availability: installation:<installation-id>  logical-skill:<logical-skill-id>
                group:<group-id>  plugin:<plugin-boundary-id>
  Update:       exactly one installation, logical-skill, group, or plugin selector
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
  --session-setup                    Scan native session-setup targets
  --harness <id>                     Limit Session setup to one harness
  --workspace <path>                 Set Session setup or TUI workspace context
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
    if (isSessionSetupInvocation(argv))
      return sessionSetupError(
        "invalid-usage",
        error instanceof Error ? error.message : String(error),
        2,
      );
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
      if (parsed.sessionSetup)
        return result(await sessionSetupScan(parsed, dependencies), 0);
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
    if (parsed.command === "update") return await update(parsed, dependencies);
    if (parsed.command === "disable" || parsed.command === "enable")
      if (parsed.sessionSetup) return await sessionSetup(parsed, dependencies);
    if (parsed.command === "disable" || parsed.command === "enable")
      return await availability(parsed, dependencies);
    if (parsed.command === "restore" || parsed.command === "purge")
      return await quarantineCommand(parsed, dependencies);
    return failure("invalid-usage", "unknown command", 2);
  } catch (error: unknown) {
    const setupInvocation =
      parsed?.sessionSetup === true || isSessionSetupInvocation(argv);
    if (setupInvocation)
      return sessionSetupError(
        error instanceof PlanningError
          ? "target-not-found"
          : "operational-error",
        error instanceof Error ? error.message : String(error),
        error instanceof PlanningError ? 3 : 1,
      );
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
    | "update"
    | "remove"
    | "restore"
    | "purge";
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly force: boolean;
  readonly bruteForce: boolean;
  readonly all: boolean;
  readonly includePlugins: boolean;
  readonly sessionSetup: boolean;
  readonly harness: SetupHarnessId | undefined;
  readonly workspace: string | undefined;
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
    includePlugins = false,
    sessionSetup = false;
  let harness: SetupHarnessId | undefined;
  let harnessCount = 0;
  let workspace: string | undefined;
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
      sessionSetup,
      harness,
      workspace,
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
      sessionSetup,
      harness,
      workspace,
      adapters,
      adapterTrusts,
      packageTrusts,
      values,
    };
  }
  if (
    [
      "scan",
      "disable",
      "enable",
      "update",
      "remove",
      "restore",
      "purge",
    ].includes(first)
  )
    command = first as Parsed["command"];
  else throw new Error(`unknown command: ${first}`);
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--json") continue;
    else if (value === "--session-setup") sessionSetup = true;
    else if (value === "--harness") {
      const requested = argv[++index];
      if (
        requested !== "codex" &&
        requested !== "claude-code" &&
        requested !== "gemini-cli"
      )
        throw new Error("--harness requires codex, claude-code, or gemini-cli");
      harnessCount += 1;
      harness = requested;
    } else if (value === "--workspace") {
      const requested = argv[++index];
      if (requested === undefined || requested.startsWith("-"))
        throw new Error("--workspace requires a path");
      workspace = resolve(requested);
    } else if (value === "--dry-run") dryRun = true;
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
    !sessionSetup &&
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
  const setupSelectors = values.filter((value) => value.startsWith("setup:"));
  if (harnessCount > 1) throw new Error("--harness may be supplied only once");
  if (sessionSetup && command !== "scan")
    throw new Error("--session-setup is valid only for scan");
  if (
    setupSelectors.length > 0 &&
    command !== "enable" &&
    command !== "disable"
  )
    throw new Error("setup selectors are valid only for enable or disable");
  if (setupSelectors.length > 0 && setupSelectors.length !== values.length)
    throw new Error("cannot mix setup and legacy selectors");
  if (setupSelectors.length > 0) sessionSetup = true;
  if (!sessionSetup && (harness !== undefined || workspace !== undefined))
    throw new Error(
      "--harness and --workspace apply only to Session setup commands",
    );
  if (
    sessionSetup &&
    command === "scan" &&
    (values.length > 0 ||
      dryRun ||
      yes ||
      force ||
      bruteForce ||
      all ||
      includePlugins ||
      packageTrusts.length > 0 ||
      adapters.length > 0 ||
      adapterTrusts.length > 0)
  )
    throw new Error(
      "session setup scan accepts only --session-setup, --harness, --workspace, and --json",
    );
  if (sessionSetup && (command === "enable" || command === "disable")) {
    if (harness === undefined)
      throw new Error("session setup mutation requires --harness");
    if (values.length === 0)
      throw new Error(
        `${command} requires at least one setup:<target-id> selector`,
      );
    if (values.some((value) => !/^setup:[^\s:]+$/u.test(value)))
      throw new Error(
        "session setup mutations require exact setup:<target-id> selectors",
      );
    if (
      force ||
      bruteForce ||
      all ||
      includePlugins ||
      packageTrusts.length > 0 ||
      adapters.length > 0 ||
      adapterTrusts.length > 0
    )
      throw new Error(
        "session setup mutations do not accept legacy force, all, fallback, or adapter options",
      );
  }
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
  if (command === "update" && values.length !== 1)
    throw new Error("update requires exactly one selector");
  if (command === "update" && (all || includePlugins || force || bruteForce))
    throw new Error(
      "update does not accept --all, --include-plugins, --force, or --brute-force",
    );
  return {
    command,
    dryRun,
    yes,
    force,
    bruteForce,
    all,
    includePlugins,
    sessionSetup,
    harness,
    workspace,
    adapters,
    adapterTrusts,
    packageTrusts,
    values,
  };
}

async function update(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const scanned = await scanWithContext(
    args.adapters,
    args.adapterTrusts,
    dependencies,
  );
  const target = resolveUpdateSelector(scanned.inventory, args.values[0]!);
  const planner = dependencies.planUpdate ?? planUpdate;
  const updatePlan = planner(scanned.inventory, { target, force: false });
  const planEnvelope = {
    schemaVersion: 1 as const,
    kind: "update-plan" as const,
    plan: updatePlan,
  };
  if (args.dryRun || updatePlan.blocks.length > 0)
    return result(planEnvelope, updatePlan.blocks.length === 0 ? 0 : 3);
  if (!args.yes)
    return result(
      {
        schemaVersion: 1,
        kind: "confirmation-required",
        operation: "update",
        plan: updatePlan,
      },
      3,
    );
  const approvals = updateGrants(updatePlan, scanned.newAdapterTrusts, args);
  if (!hasRequiredUpdateTrust(updatePlan, approvals))
    return result(
      {
        schemaVersion: 1,
        kind: "confirmation-required",
        operation: "update",
        plan: updatePlan,
      },
      3,
    );
  if (
    dependencies.executeUpdate === undefined &&
    (dependencies.scan !== undefined || dependencies.planUpdate !== undefined)
  )
    throw new Error(
      "executeUpdate must be injected with Update CLI scan or Planning dependencies",
    );
  const report =
    dependencies.executeUpdate === undefined
      ? await productionExecuteUpdate(
          updatePlan,
          args.adapters,
          args.adapterTrusts,
          scanned.newAdapterTrusts,
          approvals,
        )
      : await dependencies.executeUpdate(updatePlan, approvals);
  return result(
    { schemaVersion: 1, kind: "update-report", report },
    executionExitCode(report),
  );
}

function hasRequiredUpdateTrust(
  updatePlan: UpdatePlan,
  grants: readonly ApprovalRequirement[],
): boolean {
  const required = updatePlan.actions
    .flatMap((action) => action.approvals)
    .filter(
      (approval) =>
        approval.kind === "adapter-trust" || approval.kind === "package-trust",
    );
  return required.every((requirement) =>
    grants.some(
      (grant) => stringifyModel(grant, 0) === stringifyModel(requirement, 0),
    ),
  );
}

function updateGrants(
  updatePlan: UpdatePlan,
  adapterTrusts: readonly AdapterTrustApproval[],
  args: Parsed,
): readonly ApprovalRequirement[] {
  const ordinary = updatePlan.actions
    .flatMap((action) => action.approvals)
    .filter(
      (approval) =>
        approval.kind !== "adapter-trust" && approval.kind !== "package-trust",
    );
  return uniqueApprovals([
    ...ordinary,
    ...adapterTrusts.map((approval): ApprovalRequirement => ({
      kind: "adapter-trust",
      adapterId: approval.adapterId,
      contentHash: approval.contentHash,
    })),
    ...args.packageTrusts,
  ]);
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

async function sessionSetupScan(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<SessionSetupSnapshot> {
  return scanSessionSetupWithContext(args, dependencies);
}

async function sessionSetup(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const snapshot = await scanSessionSetupWithContext(args, dependencies);
  const operation = args.command as "enable" | "disable";
  const targets = args.values.map((selector) => {
    const id = selector.slice("setup:".length);
    const target = snapshot.targets.find((candidate) => candidate.id === id);
    return target === undefined
      ? missingSessionSetupRef(id)
      : sessionSetupRef(target);
  }) as [SessionSetupTargetRef, ...SessionSetupTargetRef[]];
  const crossHarness = args.values
    .map((selector) =>
      snapshot.targets.find(
        (target) => target.id === selector.slice("setup:".length),
      ),
    )
    .find(
      (target) => target !== undefined && target.harnessId !== args.harness,
    );
  if (crossHarness !== undefined)
    return sessionSetupError(
      "invalid-usage",
      `setup target ${crossHarness.id} belongs to ${crossHarness.harnessId}, not requested harness ${args.harness}`,
      2,
    );
  const planner = dependencies.planSessionSetup ?? planSessionSetup;
  const plan = planner(snapshot, {
    schemaVersion: 1,
    kind: "session-setup-intent",
    action: operation,
    harnessId: args.harness!,
    workspace: snapshot.workspace,
    targets,
  });
  if (args.dryRun || plan.blocks.length > 0 || plan.errors.length > 0)
    return result(
      plan,
      plan.blocks.length === 0 && plan.errors.length === 0 ? 0 : 3,
    );
  if (!args.yes)
    return result(
      {
        schemaVersion: 1,
        kind: "session-setup-confirmation-required",
        operation,
        plan,
      },
      3,
    );
  const approvals = {
    grants: plan.actions.flatMap((action) => action.approvals),
  };
  if (
    dependencies.executeSessionSetup === undefined &&
    (dependencies.scanSessionSetup !== undefined ||
      dependencies.planSessionSetup !== undefined)
  )
    throw new Error(
      "executeSessionSetup must be injected with Session setup CLI scan or Planning dependencies",
    );
  const report =
    dependencies.executeSessionSetup === undefined
      ? await productionExecuteSessionSetup(plan, args)
      : await dependencies.executeSessionSetup(plan, approvals);
  return result(report, sessionSetupExitCode(report));
}

async function scanSessionSetupWithContext(
  args: Parsed,
  dependencies: CliDependencies,
): Promise<SessionSetupSnapshot> {
  const request = {
    workspace: { path: args.workspace ?? process.cwd() },
    ...(args.harness === undefined ? {} : { harnessId: args.harness }),
  };
  if (dependencies.scanSessionSetup !== undefined)
    return dependencies.scanSessionSetup(request);
  return createSessionSetupScanner({
    now: () => new Date(),
    environment: defaultInventoryScanEnvironment(),
    commandRunner: systemCommandRunner,
  }).scanSessionSetup(request);
}

async function productionExecuteSessionSetup(
  plan: SessionSetupPlan,
  args: Parsed,
): Promise<SessionSetupReport> {
  const stateRoot = defaultLocalStateRoot();
  const scan = () => scanSessionSetupWithContext(args, {});
  return executeSessionSetup(
    plan,
    { grants: plan.actions.flatMap((action) => action.approvals) },
    {
      scan,
      replan: planSessionSetup,
      configurationWriter: createBuiltInSessionSetupConfigurationWriter(
        args.workspace ?? process.cwd(),
      ),
      processRunner: systemExecutionProcessRunner,
      inspectGitProtection: (path, artifactType) =>
        inspectGitProtection(
          path,
          artifactType?.kind === "directory",
          systemCommandRunner,
        ),
      auditWriter: createFileSessionSetupExecutionAuditWriter(stateRoot),
      now: () => new Date(),
    },
  );
}

function sessionSetupRef(target: SessionSetupTarget): SessionSetupTargetRef {
  switch (target.kind) {
    case "skill-exposure":
      return {
        kind: target.kind,
        targetId: target.id,
        installationId: target.installationId,
      };
    case "plugin":
      return {
        kind: target.kind,
        targetId: target.id,
        pluginBoundaryId: target.pluginBoundaryId,
      };
    case "mcp-registration":
      return {
        kind: target.kind,
        targetId: target.id,
        declarationSourceId: target.declarationSource.sourceId,
        serverKey: target.serverKey,
      };
    case "app-binding":
      return {
        kind: target.kind,
        targetId: target.id,
        declarationSourceId: target.declarationSource.sourceId,
        alias: target.alias,
        connectorId: target.connectorId,
      };
  }
}

function missingSessionSetupRef(id: string): SessionSetupTargetRef {
  return { kind: "skill-exposure", targetId: id, installationId: id };
}

function sessionSetupExitCode(report: SessionSetupReport): number {
  return report.status === "succeeded" || report.status === "unchanged"
    ? 0
    : report.status === "blocked"
      ? 3
      : 1;
}

function isSessionSetupInvocation(argv: readonly string[]): boolean {
  return (
    argv.includes("--session-setup") ||
    argv.some((value) => value.startsWith("setup:"))
  );
}

function sessionSetupError(
  code: string,
  message: string,
  exitCode: number,
): CliResult {
  return result(
    { schemaVersion: 1, kind: "session-setup-error", code, message },
    exitCode,
  );
}

function availabilityGrants(
  availabilityPlan: AvailabilityPlan,
): readonly ApprovalRequirement[] {
  return uniqueApprovals(
    availabilityPlan.actions.flatMap((action) => action.approvals),
  );
}

function uniqueApprovals(
  approvals: readonly ApprovalRequirement[],
): readonly ApprovalRequirement[] {
  return approvals.filter(
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
  workspaceOverride?: string,
): Promise<ScanContext> {
  if (dependencies.scan !== undefined)
    return {
      inventory: await dependencies.scan(adapterPaths),
      newAdapterTrusts: [],
    };
  const home = homedir();
  const workspace = workspaceOverride ?? process.cwd();
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
  const environment = defaultInventoryScanEnvironment();
  const inventory = await createInventoryScanner({
    now: () => new Date(),
    environment: {
      ...environment,
      workspaceDirectory: workspaceOverride ?? environment.workspaceDirectory,
    },
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

async function productionExecute(
  removalPlan: RemovalPlan,
  adapterPaths: readonly string[],
  adapterTrusts: readonly AdapterTrustApproval[],
  newAdapterTrusts: readonly AdapterTrustApproval[],
  approvals: readonly ApprovalRequirement[],
  workspaceOverride?: string,
): Promise<ExecutionReport> {
  const stateRoot = defaultLocalStateRoot();
  const adapterTrustStore = createFileAdapterTrustStore(stateRoot);
  for (const approval of newAdapterTrusts)
    await adapterTrustStore.trust(approval);
  const report = await createExecutionModule({
    scan: () =>
      scanWithContext(adapterPaths, adapterTrusts, {}, workspaceOverride).then(
        (value) => value.inventory,
      ),
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
  workspaceOverride?: string,
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
    scan: () =>
      scanWithContext(adapterPaths, adapterTrusts, {}, workspaceOverride).then(
        (value) => value.inventory,
      ),
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

async function productionExecuteUpdate(
  updatePlan: UpdatePlan,
  adapterPaths: readonly string[],
  adapterTrusts: readonly AdapterTrustApproval[],
  newAdapterTrusts: readonly AdapterTrustApproval[],
  approvals: readonly ApprovalRequirement[],
  workspaceOverride?: string,
): Promise<UpdateReport> {
  const stateRoot = defaultLocalStateRoot();
  const adapterTrustStore = createFileAdapterTrustStore(stateRoot);
  for (const approval of newAdapterTrusts)
    await adapterTrustStore.trust(approval);
  return createExecutionModule({
    scan: () =>
      scanWithContext(adapterPaths, adapterTrusts, {}, workspaceOverride).then(
        (value) => value.inventory,
      ),
    replan: plan,
    replanUpdate: planUpdate,
    quarantine: createQuarantineModule(),
    processRunner: systemExecutionProcessRunner,
    inspectGitProtection: (path, artifactType) =>
      inspectGitProtection(
        path,
        artifactType?.kind === "directory",
        systemCommandRunner,
      ),
    auditWriter: createFileExecutionAuditWriter(stateRoot),
    updateAuditWriter: createFileUpdateExecutionAuditWriter(stateRoot),
    packageTrustStore: createFilePackageTrustStore(stateRoot),
    now: () => new Date(),
    stateRoot,
  }).executeUpdate(updatePlan, { grants: approvals });
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
  if (argv.length === 0 || argv[0] === "--workspace") {
    const workspace =
      argv.length === 0
        ? process.cwd()
        : argv.length === 2 && argv[1] !== undefined && !argv[1].startsWith("-")
          ? resolve(argv[1])
          : null;
    if (workspace === null) {
      process.stderr.write("lampwright: --workspace requires one path\n");
      process.exitCode = 2;
      return;
    }
    const quarantine = createQuarantineModule();
    const disabledStorage = createProductionDisabledStorage();
    const outcome = await runTui(
      {
        workspace: { path: workspace },
        scan: async () =>
          (await scanWithContext([], [], {}, workspace)).inventory,
        plan,
        execute: (removalPlan, approvals) =>
          productionExecute(removalPlan, [], [], [], approvals, workspace),
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
            workspace,
          ),
        planUpdate,
        executeUpdate: (updatePlan, approvals) =>
          productionExecuteUpdate(updatePlan, [], [], [], approvals, workspace),
        scanSessionSetup: () =>
          createSessionSetupScanner({
            now: () => new Date(),
            environment: defaultInventoryScanEnvironment(),
            commandRunner: systemCommandRunner,
          }).scanSessionSetup({ workspace: { path: workspace } }),
        planSessionSetup,
        executeSessionSetup: (setupPlan, approvals) =>
          executeSessionSetup(setupPlan, approvals, {
            scan: () =>
              createSessionSetupScanner({
                now: () => new Date(),
                environment: defaultInventoryScanEnvironment(),
                commandRunner: systemCommandRunner,
              }).scanSessionSetup({ workspace: { path: workspace } }),
            replan: planSessionSetup,
            configurationWriter:
              createBuiltInSessionSetupConfigurationWriter(workspace),
            processRunner: systemExecutionProcessRunner,
            inspectGitProtection: (path, artifactType) =>
              inspectGitProtection(
                path,
                artifactType?.kind === "directory",
                systemCommandRunner,
              ),
            auditWriter: createFileSessionSetupExecutionAuditWriter(
              defaultLocalStateRoot(),
            ),
            now: () => new Date(),
          }),
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
  if (output.kind === "session-setup-snapshot") {
    const sources = Array.isArray(output.sources)
      ? output.sources.filter(isRecord)
      : [];
    const unavailable = sources.filter((source) => source.status !== "success");
    const lines = [
      `Session setup: ${Array.isArray(output.targets) ? output.targets.length : 0} target(s) in ${String(isRecord(output.workspace) ? output.workspace.path : "unknown workspace")}; ${unavailable.length} source(s) unavailable, invalid, or incomplete.`,
    ];
    for (const source of unavailable)
      lines.push(
        `- Source ${String(isRecord(source.source) ? source.source.sourceId : "unknown")}: ${String(source.status)}${source.reason === null || source.reason === undefined ? "" : `; ${String(source.reason)}`}.`,
      );
    return `${lines.join("\n")}\n`;
  }
  if (output.kind === "session-setup-plan")
    return humanSessionSetupPlan(output);
  if (output.kind === "session-setup-confirmation-required")
    return `${humanSessionSetupPlan(output.plan)}Confirmation required for ${String(output.operation)}. Re-run with --yes after reviewing every scope and effect.\n`;
  if (output.kind === "session-setup-report")
    return `Session setup ${String(output.status)}. A new session may be required before native policy changes take effect.\n`;
  if (output.kind === "session-setup-error")
    return `${String(output.code)}: ${String(output.message)}\n`;
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
  if (output.kind === "update-plan") return humanUpdatePlan(output.plan);
  if (output.kind === "confirmation-required")
    return `${humanPlan(output.plan)}Confirmation required for ${String(output.operation)}. ${output.operation === "remove" || output.operation === "update" ? "Supply every approval flag shown above before executing." : "Re-run with --yes after reviewing this plan."}\n`;
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
  if (output.kind === "update-report" && isRecord(output.report))
    return humanUpdateReport(output.report);
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
  if (isRecord(plan.intent) && isRecord(plan.intent.target))
    return humanUpdatePlan(plan);
  return humanRemovalPlan(plan);
}

function humanUpdatePlan(plan: unknown): string {
  if (!isRecord(plan)) return "Update Plan unavailable.\n";
  const target =
    isRecord(plan.intent) && isRecord(plan.intent.target)
      ? describeTarget(plan.intent.target)
      : "unknown target";
  const actions = Array.isArray(plan.actions)
    ? plan.actions.filter(isRecord)
    : [];
  const blocks = Array.isArray(plan.blocks) ? plan.blocks.filter(isRecord) : [];
  const warnings = Array.isArray(plan.warnings)
    ? plan.warnings.filter(isRecord)
    : [];
  const checks = Array.isArray(plan.verificationChecks)
    ? plan.verificationChecks.filter(isRecord)
    : [];
  const lines = [
    `Update Plan: ${target}; ${actions.length} Owner action(s), ${blocks.length} block(s), ${warnings.length} warning(s).`,
  ];
  for (const action of actions) {
    const operation = isRecord(action.operation) ? action.operation : {};
    lines.push(`Action ${String(action.id)}:`);
    lines.push(`- Owner: ${describeOwner(operation.owner)}`);
    lines.push(
      `- Authority: Adapter ${String(operation.adapterId)}, operation ${String(operation.operationId)}, external selector ${String(operation.externalId)}`,
    );
    lines.push(
      `- Owner invocation: ${describeInvocation(operation.invocation)}`,
    );
    lines.push(
      `- Source policy: ${describeSource(operation.source)}; ref ${operation.ref === null ? "not pinned" : String(operation.ref)}; ${describeScope(operation.scope)}`,
    );
    const revisions = Array.isArray(operation.currentRevision)
      ? operation.currentRevision.filter(isRecord)
      : [];
    lines.push("- Current local evidence:");
    lines.push(
      ...(revisions.length === 0
        ? ["  - unavailable"]
        : revisions.map((revision) => `  - ${describeRevision(revision)}`)),
    );
    const effects = Array.isArray(operation.effects)
      ? operation.effects.filter(isRecord)
      : [];
    lines.push("- Affected boundary:");
    lines.push(
      ...(effects.length === 0
        ? ["  - none declared"]
        : effects.map(
            (effect) =>
              `  - ${String(effect.kind)} ${String(effect.path)} (${effect.exists === true ? "present" : "absent"}; ${describeProtection(effect.protection)})`,
          )),
    );
    const network = isRecord(operation.network) ? operation.network : {};
    lines.push(
      network.kind === "required"
        ? `- Network: required; ${String(network.reason)}`
        : "- Network: not required by the reviewed operation",
    );
    const packageDownload = isRecord(operation.packageDownload)
      ? operation.packageDownload
      : {};
    lines.push(
      packageDownload.kind === "possible"
        ? `- Ephemeral package: ${String(packageDownload.packageName)}@${String(packageDownload.packageVersion)} may download or use a cache`
        : "- Ephemeral package: none",
    );
    lines.push(`- Adapter trust: ${describeTrust(operation.trust)}`);
    const verifications = Array.isArray(operation.verifications)
      ? operation.verifications.filter(isRecord)
      : [];
    lines.push("- Verification after execution:");
    lines.push(
      ...(verifications.length === 0
        ? ["  - none declared"]
        : verifications.map(
            (verification) => `  - ${describeVerification(verification)}`,
          )),
    );
  }
  if (blocks.length > 0) {
    lines.push("Absolute blocks:");
    lines.push(...blocks.map((block) => `- ${describeBlock(block)}`));
  }
  if (warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(
      ...warnings.map((warning) => `- ${describeUpdateWarning(warning)}`),
    );
  }
  lines.push(
    `Verification Plan: ${checks.length} Inventory check(s) must preserve identity, source policy, boundary, and availability.`,
  );
  lines.push(
    "Automatic rollback: unavailable. A failed Update stops for review.",
  );
  const guidance = approvalGuidance(plan).trimEnd();
  if (guidance.length > 0) lines.push(guidance);
  return `${lines.join("\n")}\n`;
}

function humanUpdateReport(report: Record<string, unknown>): string {
  const targets = Array.isArray(report.targetResults)
    ? report.targetResults.filter(isRecord)
    : [];
  const checks = Array.isArray(report.verificationResults)
    ? report.verificationResults.filter(isRecord)
    : [];
  const lines = [`Update ${String(report.status)}.`];
  for (const target of targets) {
    lines.push(
      `Target ${describeTarget(target.target)}: ${String(target.status)}${typeof target.reason === "string" ? `; ${target.reason}` : ""}.`,
    );
  }
  const successfulTarget = targets.every(
    (target) => target.status === "updated" || target.status === "unchanged",
  );
  const updated = checks.filter(
    (check) => check.status === "passed" && check.changed === true,
  ).length;
  const unchanged = checks.filter(
    (check) => check.status === "passed" && check.changed === false,
  ).length;
  if (
    targets.length === 1 &&
    successfulTarget &&
    checks.length > 1 &&
    updated + unchanged === checks.length
  )
    lines.push(`${String(updated)} updated, ${String(unchanged)} unchanged.`);
  const passed = checks.filter((check) => check.status === "passed").length;
  lines.push(`Verification: ${passed}/${checks.length} check(s) passed.`);
  if (targets.some((target) => target.status === "unchanged"))
    lines.push(
      "The Owner completed, but the observable local revision evidence did not change.",
    );
  if (report.rescanError !== null && isRecord(report.rescanError))
    lines.push(
      `Final Inventory failed: ${String(report.rescanError.message)}.`,
    );
  return `${lines.join("\n")}\n`;
}

function describeTarget(value: unknown): string {
  if (!isRecord(value)) return "unknown target";
  if (value.kind === "installation")
    return `Installation ${String(value.installationId)}`;
  if (value.kind === "logical-skill")
    return `Logical Skill ${String(value.logicalSkillId)}`;
  if (value.kind === "source-group")
    return `Installation Group ${String(value.groupId)}`;
  if (value.kind === "plugin")
    return `Plugin ${String(value.pluginBoundaryId)}`;
  return `unknown target ${String(value.kind)}`;
}

function describeOwner(value: unknown): string {
  if (!isRecord(value)) return "unresolved";
  if (value.kind === "manager") return `Manager ${String(value.managerId)}`;
  if (value.kind === "plugin") return `Plugin ${String(value.pluginId)}`;
  return String(value.kind);
}

function describeSource(value: unknown): string {
  if (!isRecord(value)) return "unresolved source";
  return `${String(value.id)}${typeof value.url === "string" ? ` (${value.url})` : ""}`;
}

function describeInvocation(value: unknown): string {
  if (!isRecord(value)) return "unresolved";
  const workingDirectory = isRecord(value.workingDirectory)
    ? value.workingDirectory.kind === "exact"
      ? ` from ${String(value.workingDirectory.path)}`
      : " from an isolated temporary directory"
    : "";
  if (value.kind === "direct" && isRecord(value.command))
    return `${String(value.command.executable)} ${Array.isArray(value.command.arguments) ? value.command.arguments.map(String).join(" ") : ""}${workingDirectory}`;
  if (value.kind === "ephemeral-package" && isRecord(value.packageExecution))
    return `${String(value.packageExecution.runner)} ${String(value.packageExecution.packageName)}@${String(value.packageExecution.packageVersion)} ${Array.isArray(value.packageArguments) ? value.packageArguments.map(String).join(" ") : ""}${workingDirectory}`;
  return "unresolved";
}

function describeScope(value: unknown): string {
  if (!isRecord(value)) return "Scope unresolved";
  if (value.kind === "workspace")
    return `workspace Scope ${String(value.workspacePath)}`;
  if (value.kind === "agent") return `agent Scope ${String(value.agentId)}`;
  return `${String(value.kind)} Scope`;
}

function describeRevision(value: Record<string, unknown>): string {
  if (value.kind === "content-hash" && isRecord(value.digest))
    return `content digest ${String(value.digest.digest)} at ${String(value.path)}`;
  return `${String(value.format)} value ${String(value.value)} at ${String(value.path)} ${String(value.recordPointer)}`;
}

function describeProtection(value: unknown): string {
  if (!isRecord(value)) return "protection unresolved";
  const git = isRecord(value.git) ? String(value.git.kind) : "unresolved Git";
  const system = isRecord(value.system)
    ? String(value.system.kind)
    : "unresolved System";
  const filesystem = isRecord(value.filesystem)
    ? String(value.filesystem.kind)
    : "unresolved filesystem";
  return `Git ${git}, System ${system}, filesystem ${filesystem}`;
}

function describeTrust(value: unknown): string {
  if (!isRecord(value)) return "unresolved";
  return value.kind === "trusted"
    ? "trusted"
    : `blocked for ${String(value.adapterId)}:${String(value.contentHash)}`;
}

function describeVerification(value: Record<string, unknown>): string {
  if (value.kind === "command-succeeds" && isRecord(value.command))
    return `approved command ${String(value.command.executable)} ${Array.isArray(value.command.arguments) ? value.command.arguments.map(String).join(" ") : ""}`;
  const detail =
    typeof value.path === "string"
      ? value.path
      : typeof value.externalId === "string"
        ? value.externalId
        : "reviewed locator";
  return `${String(value.kind)} ${detail}`;
}

function describeUpdateWarning(value: Record<string, unknown>): string {
  if (value.kind === "package-download")
    return `ephemeral package ${String(value.packageName)}@${String(value.packageVersion)} may download or use a cache`;
  if (typeof value.reason === "string")
    return `${String(value.kind)}: ${value.reason}`;
  return String(value.kind);
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

function humanSessionSetupPlan(plan: unknown): string {
  if (!isRecord(plan)) return "Session setup plan unavailable.\n";
  const targets = Array.isArray(plan.targets)
    ? plan.targets.filter(isRecord)
    : [];
  const blocks = Array.isArray(plan.blocks) ? plan.blocks.filter(isRecord) : [];
  const warnings = Array.isArray(plan.warnings)
    ? plan.warnings.filter(isRecord)
    : [];
  const lines = [
    `Session setup plan: ${targets.length} target(s), ${Array.isArray(plan.actions) ? plan.actions.length : 0} native action(s), ${blocks.length} block(s).`,
  ];
  const errors = Array.isArray(plan.errors) ? plan.errors.filter(isRecord) : [];
  for (const error of errors)
    lines.push(
      `- Planning error: ${String(error.kind)}${typeof error.reason === "string" ? `; ${error.reason}` : ""}.`,
    );
  for (const target of targets) {
    const source = isRecord(target.source) ? target.source : null;
    lines.push(
      `- Target: ${String(target.name)} (setup:${String(target.id)}; ${String(target.kind)}; harness ${String(target.harnessId)}; source ${source?.sourceId ?? "unknown"}).`,
    );
  }
  const actions = Array.isArray(plan.actions)
    ? plan.actions.filter(isRecord)
    : [];
  for (const action of actions) {
    const mutations = Array.isArray(action.mutations)
      ? action.mutations.filter(isRecord)
      : [];
    for (const mutation of mutations) {
      const authority = isRecord(mutation.authority)
        ? mutation.authority
        : null;
      const source =
        authority !== null && isRecord(authority.source)
          ? authority.source
          : null;
      lines.push(
        `- Native effect: ${String(mutation.kind)} selector ${String(mutation.selectorId)} sets policy ${String(mutation.policy)}${source === null ? "" : ` in source ${String(source.sourceId)}`}.`,
      );
    }
  }
  for (const warning of warnings) {
    if (warning.kind === "control-scope" && isRecord(warning.scope))
      lines.push(
        `- Effect scope: ${describeScope(warning.scope)}${warning.scope.kind === "user" ? "; affects future sessions in other projects" : ""}.`,
      );
    else if (warning.kind === "activation")
      lines.push(
        `- Activation: ${String(warning.activation)}; a new session may be required.`,
      );
    else if (
      warning.kind === "source-unavailable" ||
      warning.kind === "source-invalid" ||
      warning.kind === "source-incomplete"
    )
      lines.push(
        `- Source ${String(warning.kind)}: ${String(warning.reason ?? "native evidence is not complete")}.`,
      );
    else if (warning.kind === "owner-alternative")
      lines.push(
        `- Owner alternative: select ${isRecord(warning.owner) ? `setup:${String(warning.owner.targetId)}` : "the owner"} explicitly for a separate review.`,
      );
  }
  for (const target of targets)
    if (isRecord(target.state) && target.state.accountState === "unknown")
      lines.push(`- ${String(target.name)}: account connectivity is unknown.`);
  for (const block of blocks) {
    if (block.kind === "owner-gate")
      lines.push(
        `- Block: the selected target needs its owner enabled. Select ${isRecord(block.owner) ? `setup:${String(block.owner.targetId)}` : "the owner"} explicitly for a separate setup review.`,
      );
    else if (
      ["source-unavailable", "source-invalid", "source-incomplete"].includes(
        String(block.kind),
      )
    )
      lines.push(
        `- Block: ${String(block.kind)}; native source evidence cannot safely support this change.`,
      );
    else if (block.kind === "missing-target")
      lines.push(
        "- Block: the exact setup target is missing or stale; scan again and select its current setup ID.",
      );
    else
      lines.push(
        `- Block: ${String(block.kind)}${typeof block.reason === "string" ? `: ${block.reason}` : ""}.`,
      );
  }
  lines.push("No token saving is measured or claimed.");
  return `${[...new Set(lines)].join("\n")}\n`;
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

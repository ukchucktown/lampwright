# Module design

This document places implementation seams so the CLI, terminal UI, adapters, and platform integrations can be developed independently without duplicating cleanup logic.

## Design objective

The application should expose a small number of deep module interfaces. Callers choose what they want; modules hide discovery, ownership resolution, safety rules, ordering, filesystem behavior, and verification.

The terminal UI and non-interactive CLI are callers of the same interfaces. Neither may implement discovery, safety, or removal rules itself.

## Inventory module

Interface:

```ts
scan(request: ScanRequest): Promise<Inventory>
```

The module owns:

- Platform and project root resolution
- Built-in and local adapter discovery
- Filesystem, link, manifest, and manager evidence collection
- Finding classification
- Git protection lookup
- Skill identity evidence and logical grouping
- Normalized and namespaced metadata
- Hard-dependency and soft-reference discovery
- Materialization of planner-ready Owner operations, fallback evidence,
  resolved direct or ephemeral-package invocations, protected managed effects,
  concrete verification checks, exact declarative record cleanup, and physical
  Plugin boundaries from compiled Adapters
- Materialization of per-harness availability status, safe native enablement
  controls, exact configuration evidence, and availability verification
- Semantic Inventory fingerprinting over normalized evidence, excluding scan
  time

The returned Inventory is immutable and disposable. Tests exercise the module through `scan` against temporary filesystem fixtures and fake command execution.

The normalized Harness Exposure and native evidence contract is defined in
[Native Skill availability controls](./availability-controls.md). Status and
control support are independent; malformed or ambiguous configuration is
unresolved rather than silently treated as an enabled default.

## Planning module

Interface:

```ts
plan(inventory: Inventory, intent: RemovalIntent): RemovalPlan
planAvailability(
  inventory: Inventory,
  disabledEntries: readonly DisabledEntry[],
  intent: AvailabilityIntent,
): AvailabilityPlan
```

This is an in-process module with no side effects. It owns:

- Target resolution
- Plugin ownership expansion
- Dependency ordering
- Protection and ambiguity blocks
- Managed versus brute-force action selection
- Confirmation and package-trust requirements
- Verification expectations
- Normalized intent materialization for fresh-scan/replan validation
- Harness Exposure expansion, Native Disable selection, Suspended Disable
  eligibility, name-control ambiguity, and enablement ordering

Planning consumes only materialized Inventory evidence. It does not load or
interpret Adapter catalogs and does not probe the live machine. This preserves
the two-argument pure interface while allowing Inventory and Adapter loading to
evolve behind their own seams.

The returned plan is a complete value suitable for terminal rendering, JSON output, approval, and later execution. Tests should assert plans rather than internal rule functions.

Complete means Execution receives resolved structured invocations, precise
record mutations with expected hashes and protection, and concrete verification
checks. It must not reopen an Adapter catalog to recover executable behavior.

## Execution module

Interface:

```ts
const execution = createExecutionModule(options)
execution.execute(plan: RemovalPlan, approvals: Approvals): Promise<ExecutionReport>
execution.executeAvailability(
  plan: AvailabilityPlan,
  approvals: Approvals,
): Promise<AvailabilityReport>
```

The module owns:

- Plan freshness checks
- Managed command invocation
- Explicit failure boundaries
- Quarantine operations
- Declarative record cleanup
- Dependency-aware continuation
- Final rescans and verification
- Audit reporting
- Exact native availability configuration mutation and verification
- Suspended Disable and Enable through the Disabled Storage module

`ExecutionModuleOptions` injects a fresh Inventory scan closure, pure replanner,
Quarantine module, structured process runner, live Git inspector, package-trust
store, audit writer, clock, local-state root, and optional concurrency bound.
The module compares the full freshly replanned value excluding only its
timestamp. It never reloads an Adapter or reconstructs an Owner command.

Actions expose only approved plan authority. Managed commands run without a
shell; exact `npx` packages use an isolated temporary working directory and
cleaner-owned cache. Quarantine provenance is reconstructed from the fresh
Inventory. Declarative record cleanup verifies the complete file and selected
record hashes, captures its preimage in Quarantine, and fails closed on links,
hard links, ambiguous documents, or changes. A bounded dependency scheduler
continues independent branches and blocks dependents of failed or skipped
actions.

The final rescan drives concrete verification and any offerable fallback.
Non-target checks are bound to their authorizing action and skipped unless it
completed successfully. Managed actions retain the exact declaration evidence
needed to validate that binding without reloading an Adapter. A post-mutation
rescan failure is returned and audited as a typed report error; it cannot claim
verification or fallback. A
fallback is a new complete `brute-force` plan against the final Inventory, not
an action hidden inside the managed plan. Audit and exact package-trust state
are written lazily. See [Execution](./execution.md) and
[ADR 0005](./adr/0005-treat-owner-processes-as-declared-mutation-boundaries.md).

The external interface does not expose process spawning or filesystem primitives. Those are internal seams with production and test adapters.

Availability execution uses the same freshness, protection, exact-preimage,
dependency, audit, rescan, and typed-report rules as removal. It does not turn a
name match into identity authority, construct a harness command in the
presentation layer, or move a fallback artifact outside Disabled Storage.

## Disabled Storage module

Interface:

```ts
list(): Promise<readonly DisabledEntry[]>
suspend(request: SuspendRequest): Promise<SuspendResult>
previewEnable(entry: DisabledEntry): Promise<EnablePreview>
enable(entry: DisabledEntry): Promise<EnableResult>
```

The module owns operating-system state paths, atomic no-clobber displacement,
manifests, integrity, collision and Git-protection checks, transaction recovery,
and exact restoration metadata for Suspended Disable. Entries never expire and
the interface intentionally exposes no purge operation. `list()` and previews
create no state. Native disabled state remains in Inventory and is never
duplicated into Disabled Storage.

## Quarantine module

Interface:

```ts
list(): Promise<readonly QuarantineEntry[]>
listOperations(): Promise<readonly QuarantineOperation[]>
quarantine(request: QuarantineRequest): Promise<QuarantineResult>
previewRestore(entry: QuarantineEntry, resolution?: RestoreResolution): Promise<RestorePreview>
restore(entry: QuarantineEntry, resolution?: RestoreResolution): Promise<RestoreResult>
previewPurge(selection: QuarantineSelection): Promise<PurgePreview>
purge(selection: QuarantineSelection): Promise<PurgeResult>
previewRestoreOperation(operation: QuarantineOperation): Promise<RestoreOperationPreview>
restoreOperation(operation: QuarantineOperation): Promise<RestoreOperationResult>
previewPurgeOperation(operation: QuarantineOperation): Promise<PurgeOperationPreview>
purgeOperation(operation: QuarantineOperation): Promise<PurgeOperationResult>
```

`QuarantineResult` distinguishes a committed entry from an already-absent
source. An entry is either a displaced filesystem artifact or the captured
preimage of a declarative manager-record cleanup. Its versioned manifest records
the original `ArtifactLocation`, content integrity, restoration metadata,
timestamps, and a nonempty collection of provenance subjects so one global
record mutation can retain evidence for every affected Owner and Installation.
When an approved Brute-force Removal produces several entries, persisted
operation provenance (the approved plan identity and display names) groups them
for presentation and restore/purge review. `listOperations()` retains legacy
entries as one-entry operations; it never infers grouping from matching names or
content. Operation previews examine every entry without writes. Restore is
blocked as a group for known conflicts, while execution reports an honest
partial outcome for later races.

Restore accepts a free original or explicit alternate destination; replacing a
record postimage is a distinct resolution guarded by the exact expected hash.
The preview operations perform the same integrity, collision, and Git checks
needed to describe Restore or Purge without recovering transactions or
mutating state, so presentation dry runs do not reproduce Quarantine rules.

The module owns platform-specific state paths, atomic no-clobber moves or copies,
transaction recovery, manifests, collision and Git-protection checks, 30-day
retention, and integrity verification. State is created lazily under the shared
local-state root, which follows operating-system conventions and supports an
explicit override. `list()` and already-absent quarantine requests do not create
state; expiry runs only through `purge({ kind: "expired" })`. Callers never
manipulate quarantine directories directly.

## Adapter module

Interface:

```ts
loadAdapters(request: AdapterLoadRequest): Promise<AdapterCatalog>
```

The module owns JSONC parsing, schema validation, operating-system variants, trust checks, structured command templates, and compilation into internal discovery/removal rules. Application callers do not interpret adapter files.

Built-in ecosystem support should use the same compiled adapter representation as local adapters where possible. Ecosystem-specific code is justified only when the declarative schema cannot express a required read-only parser or platform behavior; it remains behind the Inventory or Execution interfaces rather than becoming a new external seam.

## Presentation modules

The terminal UI and CLI format Inventory, RemovalPlan, and ExecutionReport values and gather user intent or approvals. They must not:

- Traverse skill directories directly
- Infer ownership or identity
- Invoke managers
- Delete, quarantine, or restore files
- Edit harness availability settings or manipulate Disabled Storage directly
- Reimplement dependency or protection rules

This keeps interactive and automated behavior equivalent and allows both presentation modules to be built in parallel after the core value types stabilize.

## Parallel work boundaries

After the core types and fixture harness are merged, future sessions can work independently on:

- Individual built-in adapters
- Terminal UI
- Non-interactive CLI and JSON schemas
- Quarantine implementation
- Cross-platform fixture coverage

Each adapter issue should add fixtures and assert observable Inventory, RemovalPlan, and ExecutionReport behavior through the deep module interfaces.

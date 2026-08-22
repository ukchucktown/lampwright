# Non-interactive CLI

`lampwright scan`, `disable`, `enable`, `update`, `remove`, `restore`, and
`purge` are thin callers of Inventory, Disabled Storage, Planning, Execution, and
Quarantine. They do not inspect configuration, edit settings, or move Skill
paths themselves.

## Selectors and confirmation

`remove` accepts `installation:<id>`, `logical-skill:<id>`, `source:<source-id>`,
`group:<group-id>`, and `plugin:<boundary-id>`.

`disable` accepts only the exact Availability selectors
`installation:<id>`, `logical-skill:<id>`, `group:<group-id>`, and
`plugin:<plugin-boundary-id>`. `enable` accepts those selectors when the live
Inventory shows at least one natively disabled Harness Exposure or a disabled
complete Plugin boundary. It also accepts
`disabled-entry:<disabled-storage-id>` for a Suspended Disable no longer
present in Inventory. Successful suspended-disable reports return these exact
entry IDs. Prefix an ID with `disabled-entry:` for the later Enable selector.
Names and source IDs are never inferred as Availability identity.

`update` accepts exactly one `installation:<id>`, `logical-skill:<id>`,
`group:<group-id>`, or `plugin:<plugin-boundary-id>` selector. A Plugin selector
names the complete Plugin boundary. Update does not accept `source:<source-id>`,
`disabled-entry:<id>`, multiple selectors, or a name inferred from metadata.

```console
lampwright update installation:<installation-id> --dry-run --json
lampwright update logical-skill:<logical-skill-id> --yes
lampwright update group:<group-id> --yes
lampwright update plugin:<plugin-boundary-id> --yes
```

Update asks the current Owner to update the selected installed boundary. It
does not search for remote releases. Update accepts `--dry-run`, `--yes`,
`--json`, `--adapter`, `--trust-adapter`, and `--trust-package`. It rejects
`--all`, `--force`, `--brute-force`, and `--include-plugins`.

```console
lampwright disable installation:<installation-id> --dry-run --json
lampwright disable logical-skill:<logical-skill-id> --yes
lampwright disable plugin:<plugin-boundary-id> --yes
lampwright enable installation:<natively-disabled-installation-id> --yes
lampwright enable plugin:<disabled-plugin-boundary-id> --yes
lampwright enable disabled-entry:<disabled-storage-id> --yes
```

Disable accepts `--force` only for blocks the Availability Plan marks
overridable. Enable does not accept `--force`. Neither command accepts
`--all`, `--include-plugins`, `--brute-force`, or `--trust-package`. Both
support local Adapter loading, ordinary confirmation, dry run, and JSON.

`source:<source-id>` resolves to the declared Group for that source, so removing
a bundle is one target covering its exact members. When no Group declares the
source it keeps its original meaning and expands to each matching Installation.
A source present in more than one Scope is ambiguous and is rejected in favour
of `group:<group-id>`, which names an exact Group from `scan --json`.

`--all` excludes Plugin boundaries unless `--include-plugins` is also supplied,
and never includes a Plugin the agent runtime ships with itself.

`--dry-run` returns the full Availability, Update, or Removal plan or a
Quarantine preview and performs no mutation. `--yes` grants only ordinary
confirmation. `--brute-force`
selects the separately-confirmed brute-force plan, while `--force` is passed
unchanged to Planning for its documented overridable blocks. Neither option
grants Adapter or package trust. Exact local Adapter and package trust remain a
separate persisted decision.

The `--adapter <path>` option supplies local Adapters. If a local Adapter can
invoke commands, the CLI reports its exact ID and SHA-256 hash with exit status
`3`. After reviewing that file, automation can grant the exact decision with
`--trust-adapter <adapter-id>:<sha256>`. The
`--trust-package npx:<package>@<exact-version>:<adapter-sha256>` option approves
an ephemeral package. The option supports scoped npm package names. A changed
Adapter hash requires a new decision.
`scan` and every `--dry-run` remain read-only even when an explicit trust grant
is supplied. Lampwright persists a new Adapter decision only when a confirmed
removal or Update starts. Execution persists package trust only for an action
that requires the exact package tuple.

Before confirmation, the human Update review shows the target, Owner, current
local revision evidence, recorded source and ref, Scope, complete affected
boundary, network use, Adapter and package trust, blocks, warnings, and final
verification. Update has no automatic rollback. A failed Owner action stops
for review and does not produce a removal or installation fallback.

`restore` accepts exactly one Quarantine entry ID. `purge` accepts one or more
entry IDs. Their dry runs return a `quarantine-plan` containing the selected
entries, missing IDs, and the non-mutating Restore or Purge preview. Restoration
never overwrites an occupied destination through this command surface.

## JSON and exits

`--json` emits deterministic JSON (sorted object keys) with a top-level
`schemaVersion: 1`. `scan` emits the Inventory value directly. Other results
use these envelopes:

- `availability-plan` and `availability-report`
- `update-plan` and `update-report`
- `removal-plan` and `execution-report`
- `confirmation-required`
- `quarantine-plan`, `restore-result`, and `purge-result`
- `trust-required` and `error`.

An Availability report includes a sorted `disabledEntryIds` array that contains
only entries created by successful Suspended Disable actions. Native Disable and
Enable return an empty array. Embedded Inventory, AvailabilityPlan,
AvailabilityReport, UpdatePlan, UpdateReport, RemovalPlan, ExecutionReport,
Quarantine previews, and results retain their own versioned public shapes. The
published schema is [`schemas/cli-v1.schema.json`](../schemas/cli-v1.schema.json)
and is also exported from the package as `lampwright/cli-v1.schema.json`.

The CLI writes JSON to standard output even for a nonzero exit. Thus,
automation can parse one stable stream. Concise human success output uses
standard output. Human errors, blocks, and required confirmations use standard
error.

Exit status is `0` for success, `1` for operational or execution failure, `2`
for invalid CLI usage, and `3` for a blocked or stale plan, missing
confirmation, or a missing target, Disabled Storage entry, or Quarantine
entry. An Update target result of `updated` or `unchanged` uses status `0`.
`partially-updated`, `failed`, and `unresolved` use status `1`. `blocked` uses
status `3`. `unchanged` means that the Owner completed, but the local revision
evidence did not change. It does not claim that a remote release is
current. A successful target with changed and unchanged Installations uses
`updated`, exits with status `0`, and reports both counts in human output.
`partially-updated` requires an action or final verification that does not
complete successfully after another Installation changes. Other partial and
failed execution reports use status `1`.

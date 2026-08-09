# Non-interactive CLI

`skill-cleaner scan`, `disable`, `enable`, `remove`, `restore`, and `purge` are
thin callers of Inventory, Disabled Storage, Planning, Execution, and
Quarantine. They do not inspect configuration, edit settings, or move Skill
paths themselves.

## Selectors and confirmation

`remove` accepts `installation:<id>`, `logical-skill:<id>`, `source:<source-id>`,
`group:<group-id>`, and `plugin:<boundary-id>`.

`disable` accepts only the exact Availability selectors
`installation:<id>`, `logical-skill:<id>`, and `group:<group-id>`. `enable`
accepts those selectors when the live Inventory shows at least one natively
disabled Harness Exposure. It also accepts
`disabled-entry:<disabled-storage-id>` for a Suspended Disable no longer
present in Inventory. Successful suspended-disable reports return these exact
entry IDs; prefix an ID with `disabled-entry:` for the later Enable selector.
Names, source IDs, and Plugin boundaries are never inferred as Availability
identity.

```console
skill-cleaner disable installation:<installation-id> --dry-run --json
skill-cleaner disable logical-skill:<logical-skill-id> --yes
skill-cleaner enable installation:<natively-disabled-installation-id> --yes
skill-cleaner enable disabled-entry:<disabled-storage-id> --yes
```

Disable accepts `--force` only for blocks the Availability Plan marks
overridable. Enable does not accept `--force`; neither command accepts
`--all`, `--include-plugins`, `--brute-force`, or `--trust-package`. Both
support local Adapter loading, ordinary confirmation, dry run, and JSON.

`source:<source-id>` resolves to the declared Group for that source, so removing
a bundle is one target covering its exact members. When no Group declares the
source it keeps its original meaning and expands to each matching Installation.
A source present in more than one Scope is ambiguous and is rejected in favour
of `group:<group-id>`, which names an exact Group from `scan --json`.

`--all` excludes Plugin boundaries unless `--include-plugins` is also supplied,
and never includes a Plugin the agent runtime ships with itself.

`--dry-run` returns the full Availability or Removal plan or Quarantine preview
and performs no mutation. `--yes` grants only ordinary confirmation. `--brute-force`
selects the separately-confirmed brute-force plan, while `--force` is passed
unchanged to Planning for its documented overridable blocks. Neither option
grants adapter or package trust; exact local adapter/package trust remains a
separate persisted decision.

Local adapters are supplied with `--adapter <path>`. If a local adapter can
invoke commands, the CLI reports its exact ID and SHA-256 hash with exit status
`3`. After reviewing that file, automation can grant the exact decision with
`--trust-adapter <adapter-id>:<sha256>`. An ephemeral package is approved with
`--trust-package npx:<package>@<exact-version>:<adapter-sha256>`; scoped npm
package names are supported. A changed adapter hash requires a new decision.
`scan` and every `--dry-run` remain read-only even when an explicit trust grant
is supplied. A newly granted adapter decision is persisted only when a
confirmed removal is attempted, while package trust is persisted by Execution
only for an action that actually requires the exact package tuple.

`restore` accepts exactly one Quarantine entry ID. `purge` accepts one or more
entry IDs. Their dry runs return a `quarantine-plan` containing the selected
entries, missing IDs, and the non-mutating Restore or Purge preview. Restoration
never overwrites an occupied destination through this command surface.

## JSON and exits

`--json` emits deterministic JSON (sorted object keys) with a top-level
`schemaVersion: 1`. `scan` emits the Inventory value directly. Other results
use the `availability-plan`, `availability-report`, `removal-plan`,
`confirmation-required`, `execution-report`, `quarantine-plan`,
`restore-result`, `purge-result`, `trust-required`, and `error` envelopes. An
Availability report includes a sorted `disabledEntryIds` array containing only
entries created by successful Suspended Disable actions; native Disable and
Enable return an empty array. Embedded Inventory, AvailabilityPlan,
AvailabilityReport, RemovalPlan, ExecutionReport, Quarantine previews, and
results retain their own versioned public shapes. The
published schema is [`schemas/cli-v1.schema.json`](../schemas/cli-v1.schema.json)
and is also exported from the package as `skill-cleaner/cli-v1.schema.json`.

JSON is written to standard output even for a nonzero exit so automation can
parse one stable stream. Concise human success output uses standard output;
human errors, blocks, and required confirmations use standard error.

Exit status is `0` for success, `1` for operational or execution failure, `2`
for invalid CLI usage, and `3` for a blocked or stale plan, missing
confirmation, or a missing target, Disabled Storage entry, or Quarantine
entry. Partial and failed execution reports use status `1`.

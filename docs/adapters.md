# Adapter runtime

The Adapter module exposes one interface:

```ts
loadAdapters(request: AdapterLoadRequest): Promise<AdapterCatalog>
```

It loads package-owned definitions and explicitly supplied local `.jsonc`
files, validates them against their versioned schema, selects operating-system
variants, compiles structured paths and commands, verifies references, applies
content-hash trust, and returns one recursively frozen `AdapterCatalog`.
Callers do not parse or interpret adapter documents.

The editor-completable schemas are published with the package as
`lampwright/adapter-v1.schema.json` and `lampwright/adapter-v2.schema.json`.
They live at [`schemas/adapter-v1.schema.json`](../schemas/adapter-v1.schema.json)
and [`schemas/adapter-v2.schema.json`](../schemas/adapter-v2.schema.json). A
local Adapter can point an editor at the applicable installed copy:

```jsonc
{
  "$schema": "./node_modules/lampwright/schemas/adapter-v1.schema.json",
  "schemaVersion": 1,
  "id": "example.manager",
  "name": "Example manager",
  "platforms": ["darwin", "linux", "win32"],
  "roots": [
    {
      "id": "user-skills",
      "kind": "user",
      "agentId": "example-agent",
      "path": {
        "default": {
          "base": "home",
          "segments": [".example-agent", "skills"],
        },
      },
    },
  ],
}
```

JSONC comments and trailing commas are supported. Duplicate object keys,
unknown fields, unsupported schema versions, duplicate declaration IDs, and
invalid references are rejected. Only local `.jsonc` filesystem paths are
accepted; URLs and executable adapter files are not adapter sources.

## Declarative model

Both versions support these ID-addressable declarations:

- `probes`: path, executable-presence, or structured command checks.
- `roots`: the same user, agent, workspace, plugin, source, cache/vendor,
  System Skill, and unknown classifications understood by Inventory.
- `manifests`: JSON, JSONC, or YAML files with RFC 6901 record pointers, typed
  field selectors, and namespaced metadata mappings.
- `ownershipRules`: filesystem, Manager, Plugin, agent-runtime, or unknown
  ownership evidence.
- `groupingRules`: only the strong source, Plugin, canonical-target, and
  package evidence accepted by the core identity model.
- `hardDependencies`: declarative dependency targets and reasons extracted
  from manifests.
- `verificationRules`: path, manifest record, Owner state, or structured
  command checks.

Version 1 also supports `actions`. Every version 1 action is a Managed Removal
operation. Version 1 grants no Update authority.

Version 2 replaces `actions` with `lifecycleOperations`. Each operation has an
explicit `remove` or `update` lifecycle. Lampwright does not infer the lifecycle
from an operation ID or command. Each operation declares:

- An Owner and an unambiguous operation ID.
- A direct structured command or exact-version `npx` package invocation.
- An exact structured working directory or a new isolated temporary directory.
- A nonempty lifecycle-specific effect set.
- Required or absent network access. Package download remains a separate
  disclosure.
- A nonempty set of lifecycle-appropriate verification rules.

An Update effect is a `mutation-root` or `configuration-path`. It cannot be a
Removal effect. Update also declares local-change evidence. A content-hash
rule compares an installed boundary with an Owner-recorded SHA-256 digest. An
`unavailable` rule gives the reason that the Owner record cannot prove local
changes. Every Update requires both a boundary-presence check and revision
evidence. These declarations prepare Inventory materialization. The Adapter
loader does not inspect installed content or contact a remote source.

The compiled catalog exposes all operations through `lifecycleOperations`.
Version 1 actions appear there explicitly as Removal operations. The compiled
`actions` property remains a version 1-only Removal compatibility view for
current Inventory consumers. A version 2 Adapter has no legacy `actions` view.
Callers must consume its complete lifecycle operation, including working
directory and network policy, from `lifecycleOperations`.

A minimal version 2 Update declaration has this shape:

```jsonc
{
  "$schema": "./node_modules/lampwright/schemas/adapter-v2.schema.json",
  "schemaVersion": 2,
  "id": "example.manager-v2",
  "name": "Example manager v2",
  "platforms": ["darwin", "linux", "win32"],
  "roots": [
    {
      "id": "user-skills",
      "kind": "user",
      "agentId": "example-agent",
      "path": {
        "default": {
          "base": "home",
          "segments": [".example-agent", "skills"],
        },
      },
    },
  ],
  "lifecycleOperations": [
    {
      "id": "update-user-skill",
      "lifecycle": "update",
      "ownerKind": "manager",
      "operationId": "update-user-skill",
      "source": { "kind": "root", "rootId": "user-skills" },
      "workingDirectory": { "kind": "isolated-temporary" },
      "invocation": {
        "kind": "direct",
        "command": {
          "default": {
            "executable": "example-manager",
            "arguments": [
              { "kind": "literal", "value": "update" },
              { "kind": "value", "from": "externalId" },
            ],
          },
        },
      },
      "effects": [
        {
          "kind": "mutation-root",
          "path": { "kind": "value", "from": "installationPath" },
        },
      ],
      "network": {
        "kind": "required",
        "reason": "The Owner retrieves the recorded source revision.",
      },
      "localChangeEvidence": {
        "kind": "unavailable",
        "reason": "The Owner record has no content digest.",
      },
      "verificationRules": ["path-remains", "revision-readable"],
    },
  ],
  "verificationRules": [
    {
      "id": "path-remains",
      "kind": "path-present",
      "path": {
        "default": {
          "base": "home",
          "segments": [".example-agent", "skills", "selected"],
        },
      },
    },
    {
      "id": "revision-readable",
      "kind": "revision-evidence",
      "evidence": {
        "kind": "content-hash",
        "path": { "kind": "value", "from": "installationPath" },
      },
    },
  ],
}
```

Declarations may have a `platforms` filter. Paths and external commands use a
`{ default?, darwin?, linux?, win32? }` variant object; a platform-specific
value wins over `default`. An Adapter not supporting the selected platform is
omitted from that catalog. All supported variants are validated even when they
are not selected on the current machine.

Paths are structured as a base plus literal segments. Bases are `home`,
`workspace`, `config`, `state`, `cache`, and `temporary`; callers may override
their absolute values for isolated environments. Empty, absolute, separator,
`.` and `..` segments are rejected, so a definition cannot escape or request a
recursive scan of an entire base directory.

Compilation retains each selected absolute base internally alongside compiled
roots, manifests, and static managed effects. Inventory preserves lexical paths
for discovery and command context, but only uses an existing declared path when
its resolved canonical path remains inside that selected base; a symlink or
junction parent escape is inert.

Manifest selectors are literals, RFC 6901 pointers relative to a record, or
the key of a record in an object-entry collection. They do not evaluate code
or expressions.

## Inventory materialization

Inventory accepts an already-compiled `AdapterCatalog`; presentation callers
never interpret adapter files. A manifest must name its bounded `rootId`.
Each declared `skillPath` must be a relative path inside that root and match
exactly one Installation found during the same scan. Missing, duplicate,
escaping, malformed, or cross-record evidence is inert: the generic finding
remains visible and retains its generic authority.

An ownership rule, grouping rule, dependency, or action is evaluated only in
that exact root/manifest record context. Competing ownership or action claims
fail closed. Managed evidence requires a matching Owner kind, external ID,
active probes, fully resolved structured arguments, at least one complete
effect, and every requested verification. Static effects are confined to their
selected compiled path base; contextual effects are limited to the exact
Installation or manifest. Adapters never manufacture a filesystem fallback
for managed ownership; generic filesystem findings retain their
separately-confirmed Quarantine fallback.

Executable probes use PATH presence checks and do not invoke the executable.
Structured command probes are the only probes that run a command. Adapter roots
replace an equivalent default generic root; incompatible adapter claims for a
single root are rejected deterministically. Scanning and adapter materializing
perform no writes.

## Commands and package execution

A command is always an executable and an argument array. Each argument is
either a literal value or one value selected from the closed execution-time
field list in the schema. Values occupy a whole argument; string interpolation
is not supported.

The loader rejects shell command strings, known shell executables, command
dispatchers that could hide a shell invocation, interpolation syntax, newlines,
NUL bytes, and pipe, redirection, chaining, or statement tokens. Later
execution must still pass the compiled executable and arguments directly to a
process runner with shell handling disabled.

Ephemeral actions and lifecycle operations use the closed `npx` runner strategy
and separately declare a valid npm package identifier, exact Semantic Version,
possible download behavior, and package arguments. The runner is not an
operating-system variant and cannot inject flags. Direct commands remain a
separate action kind. Alternate runners, embedded package versions, tags, and
version ranges do not compile.

Every version 2 operation declares network behavior. An ephemeral-package
operation cannot claim `network: { kind: "none" }` because its approved package
may need to be downloaded. Scan, Adapter loading, Planning, and dry-run remain
offline. The declaration is disclosure for later Execution.

## Local adapter trust

Built-in definitions are trusted package content. A local Adapter with no
command probe, action, or command verification compiles as `read-only` without
approval and creates no config, state, cache, or trust file.

A command-capable local Adapter requires an `AdapterTrustApproval` matching its
Adapter ID and the SHA-256 digest of its exact raw bytes. Without it,
`loadAdapters` throws `AdapterTrustRequiredError` with the required Adapter ID,
hash, and canonical local path. After confirmation, the caller retries with
that approval. Any byte change, including comments or whitespace, produces a
new hash and therefore requires renewed approval.

Trust decisions are values at this module seam. Persisting a confirmed value
according to operating-system state conventions is a presentation/application
state concern; the loader itself performs no writes.

## Errors and determinism

`AdapterLoadError.code` distinguishes invalid requests, unsupported sources,
read and parse failures, schema/version failures, unsafe commands, duplicate
IDs, invalid references, and required trust. Validation and command-safety
checks happen before trust is requested.

The compiler sorts Adapters and declarations by ID, platform sets by the
schema's stable platform order, probe references lexically, and manifest
metadata by namespace and key. Command argument order is preserved. Equivalent
request order therefore produces the same immutable catalog.

The package's private built-in source list enters the same JSONC parse, schema,
safety, reference, variant, and compilation pipeline as local content.

## Vercel `skills` adapter

The `vercel.skills` built-in pins the native fallback package to
`skills@1.5.22`. An installed `skills` executable is preferred. When it is
missing, only global removal may use the pinned `npx` envelope, and only on the
Node.js versions supported by that package. Project removal requires the
installed executable because the manager derives project scope from its
working directory; running the package from Lampwright's isolated ephemeral
directory would target the wrong scope.

Global commands pass the pinned set of agents that support global installation
instead of relying on the manager's default all-agent expansion. In
`skills@1.5.22`, that default also visits project-only Eve and PromptScript
paths relative to the command's current directory. Excluding those agents
keeps a global action from mutating an unrelated workspace while retaining all
declared global paths. The command and path registries are checked together so
they cannot drift silently.

Installed global commands run from a fresh temporary directory. This prevents
the manager's current-directory PromptScript detection from treating an
unselected project-only agent as a remaining user of the global universal
canonical directory. Project commands instead pin the scanned workspace as
their exact working directory.

Inventory supplements the compiled command definition with the manager's
lock-record and link topology. This parser remains package-owned because the
v1 declarative format cannot safely express evolving lock records, sanitized
name collisions, XDG-aware canonical paths, or the one-to-many set of copies
and links covered by a single remove command.

## Gemini CLI adapter

The `gemini-cli` built-in uses only structured direct commands:

```text
gemini skills uninstall <name> --scope user|workspace
gemini extensions uninstall <name>
```

Workspace Skill removal runs from the selected workspace; user and extension
operations use an isolated temporary directory. Inventory declares exact
remove and configuration-modification effects plus path verification. A native
Skill command affects only its selected copy or link; an extension command is
a whole-plugin operation and is available only through explicit plugin
inclusion, with all known collateral shown in the plan.

Linked extension sources are preserved. Missing managers and failed managed
operations never trigger cleanup implicitly: a separately confirmed
Brute-force plan may quarantine only declared, safe filesystem artifacts.
Malformed records, unsafe links or paths, duplicate native names in one scope,
and duplicate extension manifest names fail closed rather than issuing an
ambiguous name-based command.

## Claude Code plugin adapter

The `claude-code.plugins` built-in models Claude Code plugins as whole-bundle
ownership boundaries. Child Skills are discoverable and searchable, but are
not independently selectable because Claude Code exposes lifecycle operations
for the containing Plugin rather than its individual components. Plugin plans
therefore disclose the known Skills, commands, agents, hooks, settings, MCP and
LSP configuration, output styles, workflows, monitors, executables, persistent
data, registry state, and the complete installed Plugin root.

Managed removal invokes the already-installed Claude executable directly with
the qualified Plugin identifier:

```text
claude plugin uninstall <plugin>@<marketplace> --scope <user|project|local> --yes
```

Project and local operations run from the exact workspace recorded by Claude;
user operations run from an isolated temporary directory. The qualified
uninstall is enabled only when the detected Claude Code version is 2.1.212 or
newer. The action verifies the installed-plugin registry, the applicable scope
settings record, and the final live Inventory. Claude may retain versioned
cache content after uninstall, so cache persistence is reported as an orphaned
non-installation cache artifact rather than treated as a failed lifecycle
action.

If the executable is absent, too old, or a managed attempt fails, a separate
Brute-force plan may quarantine the exact installed root and remove only the
hash-pinned registry and settings records. That plan always requires explicit
Brute-force confirmation. It is unavailable for administrator-managed scope,
unsafe or ambiguous manifests/records, and cache paths shared by multiple
installed scopes.

## Codex plugin adapter

The `codex.plugins` built-in treats the supported local
`codex plugin list --json` result as the authority for installed state. It does
not infer an installed Plugin from `config.toml` or from cache content. The
query runs without a shell and receives the resolved `CODEX_HOME`, privacy
flags, and `TMPDIR`, `TMP`, and `TEMP` overrides that keep the read-only scan
from creating helper-alias temporary state. Cache-only trees remain
non-installation evidence if Codex is absent, the output is invalid, or the
configuration and cache no longer agree.

Each installed Plugin is one user-scope ownership boundary. Its Skills are
searchable `managed-plugin-resource` Installations with strong Plugin identity,
but are not independently selectable. An explicit Plugin plan discloses the
complete `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>` boundary (including
stale versions), the active version and supported manifest, default and custom
Skills, commands, hooks, MCP configuration, apps, migrated command Skills,
interface assets, and retained legacy
`plugins/data/<plugin>-<marketplace>` or Agent Plugins v1
`plugins/data/agent-plugins/<sha256(marketplace + NUL + plugin)[:32]>` data.
An Agent Plugins v1 manifest is a regular root `plugin.json` with the exact
published schema URL; an unrelated root file falls back to Codex's legacy
manifest precedence. The retained data directory is impact evidence only;
Codex does not remove it during uninstall.

Managed removal invokes the installed executable directly from an isolated
temporary working directory:

```text
codex plugin remove <plugin>@<marketplace> --json
```

The declared effects are removal of every cached version below the qualified
Plugin cache boundary and Codex's update to `<CODEX_HOME>/config.toml`.
Inventory enables that operation only when the JSON identity and version are
safe, the derived cache hierarchy is made of canonically contained ordinary
directories, the selected manifest and custom paths are safe, and `config.toml`
is either absent or a stable ordinary single-link file. Verification requires
both the cache boundary and the supported Codex owner state to be absent.

Brute-force fallback is unavailable: v1 declarative record cleanup cannot
safely edit TOML. A failed Codex lifecycle operation therefore cannot silently
quarantine cache files while leaving configuration stale.

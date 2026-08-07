# Adapter runtime

The Adapter module exposes one interface:

```ts
loadAdapters(request: AdapterLoadRequest): Promise<AdapterCatalog>
```

It loads package-owned definitions and explicitly supplied local `.jsonc`
files, validates them against the version 1 schema, selects operating-system
variants, compiles structured paths and commands, verifies references, applies
content-hash trust, and returns one recursively frozen `AdapterCatalog`.
Callers do not parse or interpret adapter documents.

The editor-completable schema is published with the package as
`skill-cleaner/adapter-v1.schema.json` and lives in the repository at
[`schemas/adapter-v1.schema.json`](../schemas/adapter-v1.schema.json). A local
adapter can point an editor at the installed copy:

```jsonc
{
  "$schema": "./node_modules/skill-cleaner/schemas/adapter-v1.schema.json",
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

Version 1 supports these ID-addressable declarations:

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
- `actions`: Owner Managed Removal or an exact-version ephemeral package
  operation.
- `verificationRules`: path, manifest record, Owner state, or structured
  command checks.

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

Manifest selectors are literals, RFC 6901 pointers relative to a record, or
the key of a record in an object-entry collection. They do not evaluate code
or expressions.

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

Ephemeral actions use the closed v1 `npx` runner strategy and separately
declare a valid npm package identifier, exact Semantic Version, possible
download behavior, and package arguments. The runner is not an operating-system
variant and cannot inject flags; direct commands remain a separate action kind.
Alternate runners, embedded package versions, tags, and version ranges do not
compile.

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
working directory; running the package from the cleaner's isolated ephemeral
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

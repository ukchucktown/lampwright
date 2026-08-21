# Lampwright

`lampwright` is a cross-platform terminal application for discovering,
reversibly disabling, enabling, and safely removing AI agent Skills and
complete Plugins whether they were installed as standalone files, by a
Manager, or through a Plugin system.

The primary interface is an interactive terminal Inventory. The supported,
version-pinned invocation for the current release is:

```console
npx lampwright@0.1.1
```

Use that command after the GitHub `v0.1.1` release has been verified and
`lampwright@0.1.1` is visible on npm. It downloads the package to npm's cache;
Lampwright does not install itself globally or add a dependency to the current
project.

Before registry publication is verified, build and run from a trusted checkout:

```console
npm ci
npm run build
npm link
npx --no-install lampwright
```

`npm link` registers that checkout locally, and `--no-install` prevents `npx`
from downloading a registry package. Re-run `npm run build` after changing the
source; the link remains active.

## Safety model

Inventory is rebuilt from live, bounded evidence on every run. Lampwright
attributes ownership before Planning, prefers the Owner's supported Managed
Removal, and never silently substitutes a filesystem fallback. A separately
confirmed Brute-force Removal moves artifacts into Quarantine.

Non-ignored Git worktree content and System Skills cannot be mutated, including
with force. Matching names and hashes do not merge Skill identities. Ordinary
remove-all excludes Plugins. Plugin-owned Skills cannot be disabled
individually; where a harness exposes a safe native control, Lampwright can
disable or enable the complete Plugin while leaving its files installed.
Read-only scans, TUI browsing, and dry runs create no persistent state. The
application has no telemetry and does not transmit paths, Inventory, metadata,
or search queries.

## Interfaces

```console
lampwright                  # interactive fuzzy-search UI
lampwright scan             # print the live Inventory
lampwright update <target>  # ask the current Owner to update one target
lampwright disable <target> # natively disable or safely suspend targets
lampwright enable <target>  # enable native or Disabled Storage targets
lampwright remove <target>  # review and remove selected target(s)
lampwright restore <entry>  # restore a Quarantine entry
lampwright purge <entry>    # permanently delete Quarantine entries
```

See [Reversible Skill availability](./docs/availability.md) for Native versus
Suspended state, safe recovery, reports, and platform behavior.
See [Targeted Owner Update](./docs/update.md) for Update authority,
verification, and the no-rollback model.

Use `lampwright --help` for selectors, approvals, JSON output, dry-run, and
stable exit statuses. See the [terminal UI](./docs/tui.md) and
[non-interactive CLI](./docs/cli.md) guides for the complete behavior.

## Documentation

- [Product specification](./docs/spec.md)
- [Domain language](./CONTEXT.md)
- [Module design](./docs/module-design.md)
- [Core model](./docs/model.md)
- [Reversible Skill availability](./docs/availability.md)
- [Targeted Owner Update](./docs/update.md)
- [Inventory scanning](./docs/inventory.md)
- [Adapter runtime](./docs/adapters.md)
- [Removal planning](./docs/planning.md)
- [Execution and fallback](./docs/execution.md)
- [Terminal UI](./docs/tui.md)
- [Non-interactive CLI](./docs/cli.md)
- [0.1.1 release notes](./docs/releases/0.1.1.md)
- [Release readiness](./docs/release.md)
- [Product ideas](./docs/ideas.md) — unapproved directions under consideration
- [Architectural decisions](./docs/adr/)
- [Contributing](./CONTRIBUTING.md) and [security policy](./SECURITY.md)

## Development

Node.js 20 or newer is required.

```console
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:check
```

After building:

```console
npx --no-install lampwright
npx --no-install lampwright --help
npx --no-install lampwright --version
```

CI runs the complete gate and package audit on Node 20, 22, and 24 across
macOS, Linux, and Windows. Release preparation never authorizes npm publication,
a Git tag, or a GitHub release; follow the manual checklist in
[`docs/release.md`](./docs/release.md).

## License

MIT

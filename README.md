# Lampwright

`lampwright` is a cross-platform terminal application for discovering,
reversibly disabling, enabling, and safely removing AI agent Skills whether
they were installed as standalone files, by a Manager, or through a Plugin
system.

The primary interface is an interactive terminal inventory. Until publication, build and run it from a trusted checkout:

```console
npm ci
npm run build
node dist/cli.js
```

No npm version has been published yet. Until the first explicitly approved
release, build and run the executable from a trusted checkout.

## Safety model

Inventory is rebuilt from live, bounded evidence on every run. Lampwright
attributes ownership before Planning, prefers the Owner's supported Managed
Removal, and never silently substitutes a filesystem fallback. A separately
confirmed Brute-force Removal moves artifacts into Quarantine.

Non-ignored Git worktree content and System Skills cannot be mutated, including
with force. Matching names and hashes do not merge Skill identities. Ordinary
remove-all excludes Plugins. Read-only scans, TUI browsing, and dry runs create
no persistent state. The application has no telemetry and does not transmit
paths, Inventory, metadata, or search queries.

## Interfaces

```console
lampwright                  # interactive fuzzy-search UI
lampwright scan             # print the live Inventory
lampwright disable <target> # natively disable or safely suspend targets
lampwright enable <target>  # enable native or Disabled Storage targets
lampwright remove <target>  # review and remove selected target(s)
lampwright restore <entry>  # restore a Quarantine entry
lampwright purge <entry>    # permanently delete Quarantine entries
```

See [Reversible Skill availability](./docs/availability.md) for Native versus
Suspended state, safe recovery, reports, and platform behavior.

Use `lampwright --help` for selectors, approvals, JSON output, dry-run, and
stable exit statuses. See the [terminal UI](./docs/tui.md) and
[non-interactive CLI](./docs/cli.md) guides for the complete behavior.

## Documentation

- [Product specification](./docs/spec.md)
- [Domain language](./CONTEXT.md)
- [Module design](./docs/module-design.md)
- [Core model](./docs/model.md)
- [Reversible Skill availability](./docs/availability.md)
- [Inventory scanning](./docs/inventory.md)
- [Adapter runtime](./docs/adapters.md)
- [Removal planning](./docs/planning.md)
- [Execution and fallback](./docs/execution.md)
- [Terminal UI](./docs/tui.md)
- [Non-interactive CLI](./docs/cli.md)
- [Release readiness](./docs/release.md)
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
node dist/cli.js
node dist/cli.js --help
node dist/cli.js --version
```

CI runs the complete gate and package audit on Node 20, 22, and 24 across
macOS, Linux, and Windows. Release preparation never authorizes npm publication
or a repository visibility change; follow the manual checklist in
[`docs/release.md`](./docs/release.md).

## License

MIT

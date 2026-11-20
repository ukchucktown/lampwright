# Lampwright

**Switch agent Skills off. Keep them installed.**

![Lampwright disables four Skills, enables one again, and opens the theme picker](./.github/assets/lampwright-demo.gif)

If Lampwright saves context for you, a star on GitHub helps other people find
it.

`lampwright` is a cross-platform terminal application that manages AI agent
Skills and Plugins. It discovers installed content, lets you disable and enable
unused Skills, updates Owner-managed content, and safely removes what you no
longer need.

Lampwright's main advantage is reversible availability control. You can keep a
large Skill collection installed and expose only the Skills that you need at
the time. A smaller active set can reduce the Skill metadata that a harness
loads into model context and may lower token use. The actual savings depend on
the harness and how it loads Skills.

## Reversible Skill control

Disable makes a Skill unavailable but does not delete its identity or content.
Enable makes the Skill available again.

Lampwright prefers the native controls in Codex, Claude Code, and Gemini CLI.
When a standalone or supported Manager-owned Skill has no native control,
Lampwright can move its complete artifact set to non-expiring Disabled Storage.
Enable restores that set to its original paths and never overwrites an occupied
destination.

This model works well for installations with hundreds of Skills. You can keep
specialized Skills available on disk and activate only the set that fits your
current work.

Lampwright does not install Skills or search a registry. It manages the Skills
that an installer such as the Vercel `skills` CLI put in a directory that
Lampwright scans. See
[Lampwright and similar tools](./docs/comparison.md) for a feature matrix.

## Features

| Feature | What Lampwright does |
| --- | --- |
| Live Inventory | Finds standalone, Manager-owned, and Plugin-owned Skills in Codex, Claude Code, and Gemini CLI, in the shared `.agents/skills` directories that many harnesses read, and in the agent directories of the Vercel `skills` Manager. |
| Reversible disable and enable | Uses native harness controls when possible, or safely suspends complete supported artifact sets in Disabled Storage. |
| Plugin availability | Disables or enables a supported Plugin as one complete boundary while its files stay installed. |
| Owner-managed Update | Asks the current Owner to update an existing target, then rescans and verifies the local result. |
| Safe removal | Uses the Owner's removal operation first. A separately confirmed filesystem fallback moves content to recoverable Quarantine. |
| Built-in protection | Blocks changes to System Skills, non-ignored Git worktree content, read-only paths, and incomplete ownership boundaries. |
| Terminal and automation interfaces | Provides an interactive terminal UI, dry runs, stable JSON, and a non-interactive CLI. |
| Themes | Uses the colors of your terminal by default. You can add custom themes as TOML files, and a theme picker previews each theme on the real screen. |
| Cross-platform support | Runs on macOS, Linux, and Windows with Node.js 20 or newer. |
| Private by design | Adds no telemetry and does not transmit local paths, Inventory data, metadata, or search queries. |

## Supported harnesses

Lampwright covers a harness at one of three levels. The level depends on the
controls that the harness has and on the directory that holds the Skill.

| Level | Harnesses | What Lampwright can do |
| --- | --- | --- |
| Native controls | Codex, Claude Code, and Gemini CLI | Disable and enable a Skill or a complete Plugin through the configuration of the harness. Lampwright also finds and removes the Plugins of these harnesses, and it updates a Plugin when the Owner has an update operation. |
| Shared directory | Each harness that reads `~/.agents/skills` or `<workspace>/.agents/skills`. The path registry of `skills@1.9.0` lists 22 agents that read the project directory, for example Cursor, GitHub Copilot, OpenCode, and Pi. | Find each Skill, disable it through Disabled Storage, and remove it. |
| Vercel `skills` Manager | The 76 agents in the path registry of `skills@1.9.0`, for example Junie, Windsurf, and Continue | Find a Skill that the Manager owns in the directory of each agent, update it and remove it through the Manager, and disable it through Disabled Storage. |

The Agents column of the Inventory shows the harnesses that can load each
Skill. The name `universal` in that column is the shared `.agents/skills`
directory. Lampwright does not scan the private directory of a harness outside
these three levels unless a local Adapter that you load with `--adapter`
declares the directory as a root. See [Adapter runtime](./docs/adapters.md).

## How Lampwright compares

| Need | Lampwright | `asm` | `skills` | `skill-cli` |
| --- | --- | --- | --- | --- |
| Install a Skill or search a catalog | No | Yes | Yes | Yes |
| Disable a Skill and keep it installed | Yes, native control or Disabled Storage | Yes, renames `SKILL.md` | No command | Yes, in its own store |
| Disable or enable a complete Plugin | Yes | No | Not described | Not applicable |
| Removal that you can undo | Filesystem removals sent to Quarantine can be restored for 30 days by default. A Managed Removal has no undo. | Not described | Not described | Not described |
| Complete plan before each change | Yes, `--dry-run` | Some commands | Experimental commands | Not described |
| Protection for tracked Git files and System Skills | Yes, for each path that Lampwright or a trusted Owner declares | Not described | Not described | Not applicable |
| Token cost reports and security scans | No | Yes | Partner risk ratings before an installation from a public GitHub source | Not described |

Lampwright fits best when Skills from different tools are already installed
and you want to control them safely and reversibly. An installer fits best
when you need to find and add Skills. You can use both when the installer
puts Skills in a directory that Lampwright scans: install with `skills`, then
manage with Lampwright. The
[complete comparison](./docs/comparison.md) has the full matrix, the sources,
the date of the review, and the features that Lampwright does not have.

## Run Lampwright

The primary interface is an interactive terminal Inventory. The supported,
version-pinned invocation for the current release is:

```console
npx lampwright@0.4.1
```

This command downloads the package to npm's cache. Lampwright does not install
itself globally or add a dependency to the current project.

![Lampwright Inventory terminal interface](./docs/assets/tui-inventory.png)

The header shows the three views, which are Inventory, Disabled, and Trash, and
the selection status. The row below the header shows the keys that apply in the
current context. Press `?` for the complete key reference and `ctrl+p` for the
theme picker.

## Themes

The default theme, `terminal`, uses the 16 colors of your terminal, so
Lampwright follows a light or a dark terminal theme. The second built-in theme,
`nightfall`, uses fixed colors for a dark background.

To add a custom theme, put a TOML file in the `themes` directory of the
Lampwright configuration directory. That directory is `~/.config/lampwright`
on macOS and Linux unless `XDG_CONFIG_HOME` is set, and `%APPDATA%\lampwright`
on Windows.

```toml
# ~/.config/lampwright/themes/ocean.toml
name = "ocean"
extends = "terminal"

[styles]
title = "#3399ff bold"
focus = "white on #484e5b bold"
muted = "dim"
```

A theme file sets a style for some or all of the 11 roles, and each other role
takes its style from the theme that `extends` names. Press `ctrl+p` to open
the theme picker, which lists the built-in themes and then your custom themes.
The picker shows the real screen with the highlighted theme, and Enter saves
the selection. You can also name a theme with `--theme <name>` or with the
`LAMPWRIGHT_THEME` environment variable. See
[Theme and color](./docs/tui.md#theme-and-color) for the roles, the color
formats, and the rules for a theme file that is not valid.

## Safety model

Lampwright rebuilds Inventory from live, bounded evidence on every run. It
attributes ownership before it creates a plan. It prefers the Owner's supported
Managed Removal and never silently substitutes a filesystem fallback. A
separately confirmed Brute-force Removal moves artifacts into Quarantine.

Non-ignored Git worktree content and System Skills cannot be mutated, including
with force. Matching names and hashes do not merge Skill identities. Ordinary
remove-all excludes Plugins. Lampwright cannot disable Plugin-owned Skills
individually. When a harness exposes a safe native control, Lampwright can
disable or enable the complete Plugin and keep its files installed.

Read-only scans, TUI browsing, and dry runs create no persistent state. A theme
that you confirm in the theme picker is the one preference that Lampwright
saves. The
application has no telemetry and does not transmit paths, Inventory, metadata,
or search queries.

## Interfaces

```console
lampwright                  # interactive terminal UI
lampwright --theme <name>   # interactive terminal UI with one theme
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
See [Theme and color](./docs/tui.md#theme-and-color) for the built-in themes,
the format of a theme file, and the order in which Lampwright selects a theme.

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
- [Lampwright and similar tools](./docs/comparison.md)
- [Terminal UI](./docs/tui.md)
- [Non-interactive CLI](./docs/cli.md)
- [0.4.1 release notes](./docs/releases/0.4.1.md)
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
a Git tag, or a GitHub release. Follow the manual checklist in
[`docs/release.md`](./docs/release.md).

## License

MIT

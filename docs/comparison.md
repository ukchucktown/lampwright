# Lampwright and similar tools

Lampwright manages the Skills and the Plugins that are already on your
computer. It does not install a Skill, and it does not search a registry. If
you need an installer, use one of the other tools on this page. Lampwright can
then manage what that tool installed.

The other tools here are
[`asm`](https://github.com/luongnv89/asm) (agent-skill-manager), the Vercel
[`skills`](https://github.com/vercel-labs/skills) CLI, and
[`skill-cli`](https://github.com/VictorTomaili/skill-cli).

## How we collected the facts

We reviewed the three other tools on 2026-11-20. Each statement about another
tool comes from its README, its command reference, or its source code at that
date. We did not run the other tools. "Not described" means that the documents
we read do not describe the feature. It does not mean that the tool cannot do
it.

| Tool | Version reviewed | Sources |
| --- | --- | --- |
| Lampwright | 0.4.1 | This repository |
| `asm` | 2.24.0 | [README](https://github.com/luongnv89/asm#readme), [`src/skill-state.ts`](https://github.com/luongnv89/asm/blob/main/src/skill-state.ts), [`src/uninstaller.ts`](https://github.com/luongnv89/asm/blob/main/src/uninstaller.ts), [CI workflows](https://github.com/luongnv89/asm/tree/main/.github/workflows) |
| `skills` | 1.9.0 | [README](https://github.com/vercel-labs/skills#readme), [CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md), [CI workflow](https://github.com/vercel-labs/skills/blob/main/.github/workflows/ci.yml) |
| `skill-cli` | 0.7.2 | [README](https://github.com/VictorTomaili/skill-cli#readme) |

Each project changes often. If a cell is out of date, open an issue.

## What each tool is for

- Lampwright finds installed Skills and Plugins, identifies the Owner of each
  one, and changes them safely: disable, enable, update, and remove.
- `asm` installs Skills from GitHub or its registry and then searches, audits,
  and organizes them. It also has commands for authors of Skills.
- `skills` installs Skills from a repository into the directories of your
  agents and keeps them up to date. It is the installer of the
  [skills.sh](https://skills.sh) directory.
- `skill-cli` keeps Skills in one store of its own and decides which Skills are
  active in each project. Agents read a Skill through a `skill` command.

## Feature matrix

The rows are in the order of a Skill's life: get a Skill, see it, change its
availability, update it, and remove it. The last rows describe the interfaces
and the platform.

| Feature | Lampwright | `asm` | `skills` | `skill-cli` |
| --- | --- | --- | --- | --- |
| Install a Skill from a source | No | Yes, from GitHub or its registry | Yes, from a repository, a URL, or a local path | Yes, into its own store, through `npx skills` |
| Search a catalog of Skills | No | Yes | Yes, `skills find` | Yes, `skill search` |
| Security scan before an installation | Does not install | Yes, `asm audit security` | The README mentions security-audit requests | Not described |
| List Skills that another tool installed | Yes: standalone, Manager-owned, and Plugin-owned Skills | Yes, `asm list` across 21 providers | Yes, `skills list` marks them `untracked` | No, it lists its own store |
| Show which Manager or Plugin owns a Skill | Yes, before each plan | Not described | A lock file records the source of the Skills that it installed | Not applicable |
| Disable a Skill and keep it installed | Yes. Lampwright uses the native control of the harness when one exists. If none exists, it moves the complete artifact set to Disabled Storage. | Yes. `asm disable` renames `SKILL.md` to `SKILL.md.disabled`. | No command | Yes, for Skills in its store, with a setting for each project |
| Disable or enable a complete Plugin | Yes, where the harness has a native control | No. The README says that no `asm` command changes Skills from plugin marketplaces. | Not described | Not applicable |
| Update a Skill | Asks the current Owner to update it, then scans again and verifies the result. It does not check remote releases first. | `asm outdated` and `asm update` | `skills check` and `skills update` | `skill update` |
| Remove a Skill | Uses the removal operation of the Owner first. A filesystem fallback needs a separate confirmation and moves the content to Quarantine. | `asm uninstall` deletes the files | `skills remove` | `skill remove` deletes from its store |
| Restore a removed Skill | Yes, from Quarantine, for 30 days by default | Not described | Not described | Not described |
| Preview a change as a complete plan | Yes, `--dry-run` on each command that changes state | `--dry-run` on `publish` and on `deps cleanup` | `--dry-run` on the two experimental commands | Not described |
| Protection for files in a Git worktree | Yes. Lampwright changes a path in a Git worktree only if Git ignores the path. | Not described | Not described | Its store is outside your projects |
| Protection for the Skills that a harness supplies | Yes, System Skills are read-only | Not described | Not described | Not applicable |
| Report of the context cost of Skills | No | Yes, `asm stats --tokens` and `asm audit residency` | No | No |
| Find duplicate Skills | Shows identical copies as one row. It does not remove duplicates for you. | Yes, `asm audit` and `asm audit overlap` | Not described | Not applicable, one store |
| Tools for authors of Skills | No | Yes: `init`, `link`, `eval`, `publish` | `skills init` | No |
| Full-screen terminal UI | Yes, the primary interface | Yes, optional | Interactive prompts | Yes |
| JSON output | Yes, on each command, with a published schema | Yes, `--json` and `--machine` | `--json` on `list` | Not described |
| Harnesses | Native controls for Codex, Claude Code, and Gemini CLI. Inventory also covers the directories of the Vercel `skills` ecosystem. | 21 providers | 4 named agents and 75 more | Claude Code, Codex, Cursor, and Gemini are named |
| Telemetry | None | None | Anonymous usage data by default. Two environment variables stop it. | Not described |
| Operating systems | macOS, Linux, and Windows, each in CI | Not stated in the README. CI runs on Linux. | Not stated in the README. CI runs on Linux and Windows. | Windows, macOS, and Linux |
| Node.js | 20 or newer | 22 or newer | 22.20 or newer | 22 or newer |
| How you run it | `npx lampwright@<version>`, with no global installation | Global npm package or an installation script | `npx skills` | Global npm package |
| License | MIT | MIT | MIT | MIT |

## Which tool fits which need

Use Lampwright in these conditions:

- You have many Skills from different tools, and you want to decrease the set
  that your harness loads but keep each Skill on disk.
- You want the tool that owns a Skill to make each change, so that the records
  of that tool stay correct.
- You want a removal that you can undo.
- Your Skills come from Plugins, and you want to disable, update, or remove a
  complete Plugin.
- You work in Git repositories and want a tool that cannot change tracked
  files.
- You work on Windows and need the same behavior as on macOS and Linux.

Use `asm` in these conditions:

- You want one tool that installs Skills and also manages them.
- You want to browse a catalog, scan a Skill before you install it, or measure
  the tokens that your Skills use.
- You write Skills and want commands that create, test, and publish them.
- You use an agent that Lampwright does not support. `asm` supports 21
  providers.

Use `skills` in these conditions:

- You want the standard installer for Skills from
  [skills.sh](https://skills.sh) or from a GitHub repository.
- You want a lock file in your project, so that each member of the team
  restores the same Skills.

Use `skill-cli` in these conditions:

- You want no Skill files in the directories of your agents.
- You want a different set of active Skills in each project, from one
  configuration file.

Lampwright works together with an installer. For example, you can install
Skills with `skills` and then use Lampwright to disable, update, or remove
them. Lampwright recognizes the Vercel `skills` Manager as the Owner of those
Skills and sends each update and each removal through it.

## What Lampwright does not do

- It does not install a Skill.
- It does not search a registry or a catalog.
- It does not check for new remote releases before an update.
- It does not scan a Skill for security problems.
- It does not report the token cost of a Skill.
- It does not create, test, or publish a Skill.
- It has native availability controls for three harnesses only: Codex, Claude
  Code, and Gemini CLI.

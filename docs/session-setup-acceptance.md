# Session setup acceptance

This record maps the Session setup outcome to current implementation evidence.
The baseline includes issues #149 through #155 on integration commit
`0bfe4a8`. Issue #156 adds this record, the operator guide, and the final
terminal check.

## Automated evidence

| Outcome | Evidence |
| --- | --- |
| Public contracts and safe values | `tests/session-setup.test.ts` validates references, authority, schema output, Windows paths, owner gates, shared policies, dependencies, secret omission, and immutable public values. |
| Planning and execution | `tests/session-setup.test.ts` covers stale plans, exact approvals, dependency order, independent partial progress, unchanged results, final-scan failure, Git protection, links, hard links, races, and missing parents. |
| Codex source and controls | `tests/codex-session-setup.test.ts` covers all four target kinds, source failures, owner evidence, collisions, layered policy, workspace trust, both control directions, and safe document creation. |
| Claude Code source and controls | `tests/claude-code-session-setup.test.ts` covers Skills, Plugins, MCP servers, unavailable account connectors, scope precedence, both control directions, collisions, links, malformed owners, and preservation. |
| Gemini CLI source and controls | `tests/gemini-cli-session-setup.test.ts` covers Skills, extensions, MCP servers, unavailable account Apps, layered Enable, both control directions, collisions, malformed owners, partial results, and preservation. |
| CLI behavior | `tests/cli-session-setup.test.ts` covers harness and workspace selection, exact selectors, dry runs, confirmation, JSON envelopes, stable exits, source status, and invalid mixed commands. |
| Terminal UI behavior | `tests/tui-setup.test.ts` covers the setup area, both views, three harnesses, keyboard and pointer input, selection isolation, search, owner routes, blocked plans, confirmation, report refresh, and unavailable providers. |
| Existing lifecycle behavior | `tests/tui.test.ts` and the existing Availability, Update, Removal, Disabled Storage, and Quarantine suites remain part of the full gate. |
| The Node and operating-system matrix | `.github/workflows/ci.yml` runs format, lint, type checks, the full suite, the build, and the package audit on Node.js 20, 22, and 24 for macOS, Linux, and Windows. The issue pull request records the current nine job results. |

All filesystem tests use temporary roots or explicit fixtures. The tests do not
read or change the developer's installed agent content.

The local issue gate passed on 2026-09-20. Formatting, lint, type checks, 726
tests in 36 files, the build, and the package audit completed successfully. The
package audit found 453 intended files and 3,527,534 packed bytes.

## Real-terminal record

The issue #156 check used the built Lampwright terminal on macOS 26.7 with
Node.js 26.8.2 on Arm64. The check used a temporary home, workspace,
configuration root, state root, cache, and command path. The command path
contained Node.js and no harness client.

The check verified these paths:

- A normal `110 x 30` terminal opened the lifecycle area and the Session setup
  area.
- A `60 x 14` terminal kept the setup harness, target, and detail layout within
  the viewport.
- A live resize from `110 x 30` to `60 x 14` repainted the setup view and kept
  the focused target.
- SGR pointer input selected both area labels.
- `NO_COLOR=1` kept the same text and frame geometry without color codes.
- A fixture-backed Codex Skill completed Disable and Enable reviews. Both
  changes passed policy, effective-state, and activation verification.
- Enter on the result refreshed the setup sources and returned to the prior
  setup view.

The terminal check found that the result footer advertised Enter before the
raw and line parsers accepted it. Issue #156 corrects that parser behavior and
adds a focused regression test.

## Evidence limits

The real-terminal record verifies Lampwright interaction against an isolated
fixture. It does not claim a live Codex, Claude Code, Gemini CLI, desktop, or
account connection.

The adapter suites verify qualified native formats and offline source
contracts. The CI suite does not run installed harness binaries. A separate
client qualification is necessary when a native format or client surface
changes.

The accepted gaps remain:

- Claude account connectors and Gemini account Apps are unavailable.
- Desktop client behavior is unqualified.
- A new session activates a successful change. Lampwright does not reload an
  active session.
- Lampwright does not measure token use.

This acceptance record authorizes no npm publication, release, repository
visibility change, or integration merge to `main`.

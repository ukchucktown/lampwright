# Notes for the next Lampwright release

This file collects the release notes of changes that are not in a release yet.
The release preparation moves this text into the notes of the new version.

## Vercel `skills` 1.9.0

Lampwright now pins version 1.9.0 of the Vercel `skills` Manager. The earlier
pin was version 1.5.22.

### A new package approval

When no `skills` executable is on `PATH`, Lampwright runs the pinned package
through `npx`. Your approval of that package binds to the exact version, so the
approval of `skills@1.5.22` does not apply to `skills@1.9.0`. Lampwright asks
for a new approval before a Managed Removal or a Managed Update that uses the
package.

A command that passes `--trust-package` must name the new version. Run the
command with `--dry-run --json` to get the exact value from the plan.

### Agent paths

`skills@1.9.0` knows three more agents: fx, Posit Assistant, and Sarvam Code.
It also changes where some agents read a global Skill. Codex, Droid, Kilo Code,
and Pi now read the shared `~/.agents/skills` directory, and they get no link
of their own. Antigravity and Antigravity CLI now use `~/.gemini/config/skills`.

A Skill that `skills@1.5.22` installed can still have a link at an old path,
for example `~/.pi/agent/skills`. Lampwright continues to show that link as a
part of the Installation. The `remove` command of `skills@1.9.0` deletes the
Skill and leaves the link. After a Managed Removal, Lampwright removes each
such link that has no target.

### Project locks

`skills@1.9.0` writes version 2 of `skills-lock.json` with a new content hash.
Lampwright reads version 1 and version 2, and it uses the hash of each version
to find local changes. `skills@1.9.0` rewrites a version 1 lock as version 2
when it changes the lock.

In a project, the `remove` command of `skills@1.9.0` keeps a copy that does not
match the lock, when the copy is in a directory whose name does not start with
a dot. An Eve copy in `agent/skills` is an example. Lampwright then reports
that the Managed Removal is not complete, and it offers the fallback removal
through Quarantine.

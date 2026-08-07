# Repository guidance

## Purpose

`skill-cleaner` is a cross-platform TypeScript terminal application for discovering and safely removing AI agent skills regardless of whether they were installed as standalone files, by a manager, or through a plugin system.

The project is specification-first. Do not invent product behavior when the accepted documents or tracked issue already define it.

## Sources of truth

Read the documents relevant to the issue before changing code:

1. [Product specification](./docs/spec.md) — accepted behavior, scope, safety requirements, and MVP criteria
2. [Domain language](./CONTEXT.md) — canonical terms and distinctions
3. [Module design](./docs/module-design.md) — implementation seams and parallel work boundaries
4. [Architectural decisions](./docs/adr/) — decisions that must not be casually reversed
5. [Implementation roadmap](./docs/roadmap.md) — dependency order and parallelizable work
6. The assigned GitHub issue — the bounded outcome, acceptance criteria, dependencies, and tests for the current change

When guidance appears inconsistent, stop and reconcile it in the specification or an ADR instead of encoding an undocumented interpretation in code.

## Current structure

```text
skill-cleaner/
├── AGENTS.md              # shared repository workflow and guardrails
├── CLAUDE.md              # Claude Code pointer to AGENTS.md
├── CONTEXT.md             # ubiquitous domain language
├── README.md              # project entry point
├── docs/
│   ├── spec.md            # accepted product specification
│   ├── module-design.md   # deep module interfaces and seams
│   ├── roadmap.md         # linked GitHub issue sequence
│   └── adr/               # durable architectural decisions
└── src/ and tests/        # added by implementation issues
```

As implementation begins, organize code around the deep modules described in `docs/module-design.md`: Inventory, Planning, Execution, Quarantine, Adapter loading, and thin presentation modules for the CLI and terminal UI.

## Working an issue

1. Confirm the issue's blockers are closed or that the required interfaces already exist.
2. Read the issue, the linked specification sections, and relevant ADRs completely.
3. Keep the change limited to one issue outcome. Do not absorb adjacent backlog items for convenience.
4. Add behavior through the owning deep module interface. Do not duplicate safety or discovery logic in callers.
5. Test observable outcomes through module interfaces using isolated fixtures.
6. Run formatting, linting, type checking, unit tests, and relevant integration tests before handoff.
7. Update documentation when behavior or an interface changes. Update `CONTEXT.md` only when the domain language changes.
8. Report what changed, what was verified, and any unresolved risk. Do not close an issue until every acceptance criterion is met.

For Codex-authored branches, use the `feat/` prefix and include the issue number when practical, for example `feat/issue-4-generic-discovery`.

### Advisor and executor budget

- For implementation issues, default to one higher-effort primary Advisor and at most one lower-effort Executor when model-effort controls are available.
- Keep the roles separate. The Advisor owns issue recovery, source-of-truth reconciliation, the bounded plan, high-risk decisions, review, and final verification. The Executor owns issue-scoped edits and the initial quality-gate run; it must not expand product or architecture scope.
- Constrain Advisor messages that direct implementation: use enumerated steps and fewer than 100 words per plan, handoff, or interim summary unless a safety or specification conflict requires more context.
- Cap higher-effort Advisor model invocations at three per implementation task: scope and recovery, post-implementation review, and final verification. Configure the orchestration backend to reject a fourth call when supported; otherwise treat this as a manual hard limit and disclose the limitation.
- Avoid duplicate research. The Advisor or Executor performs each research task once, and completed findings are reused.
- Reuse the same Executor for targeted corrections rather than creating another implementation agent. The Advisor remains responsible for integrating the handoff and independently verifying the worktree.
- Do not add separate review or research agents unless the user explicitly expands this budget.

## Architectural rules

- Inventory is live, immutable, disposable state. Do not introduce an installation database.
- The terminal UI and CLI call the same Inventory, Planning, Execution, and Quarantine interfaces.
- Presentation modules must not scan directories, infer ownership, invoke managers, or mutate files directly.
- Place variation behind a real seam only when at least two adapters justify it, normally production and test implementations.
- Accept side-effecting dependencies rather than constructing them inside deep modules.
- Return plans and reports as values; keep hidden filesystem and process details behind module interfaces.
- Built-in ecosystem support should use the compiled declarative adapter representation where it can express the behavior safely.
- Use canonical terms from `CONTEXT.md`. In particular, do not conflate a Skill, Installation, Logical Skill, Plugin, Manager, Owner, or Adapter.

## Non-negotiable safety guardrails

- Never inspect or mutate the developer's real skill installations in tests. Use temporary homes, workspaces, state directories, caches, and fake command runners.
- A read-only scan, TUI browse, or dry run must create no files or persistent state.
- Never crawl an entire home directory by default. Scan only known, configured, or explicitly supplied roots.
- Never mutate a path inside a Git worktree unless Git classifies that path as ignored. `--force` cannot override this.
- Never remove System Skills supplied as inseparable agent runtime content.
- Never merge Skill identities from matching names or hashes alone.
- Never silently replace failed Managed Removal with Brute-force Removal. Fallback requires a separate plan and confirmation.
- Brute-force filesystem removal goes through Quarantine, not permanent deletion.
- Hard Dependencies block by default; Soft References warn but do not block.
- Ordinary remove-all operations exclude Plugins unless plugin inclusion is explicit.
- Do not treat plugin caches, source repositories, vendored files, or unknown `SKILL.md` files as independently removable installations.
- Adapters are versioned local JSONC data. Do not add remote adapters or executable adapter plugins in v1.
- Adapter commands use a structured executable plus argument array. Do not accept shell strings, pipes, redirection, or implicit shell interpolation.
- Do not install managers globally or add packages to a user's project. Approved ephemeral execution must pin an exact package version and disclose possible download/cache behavior.
- Do not add telemetry or transmit local paths, inventory, metadata, or search queries.
- Do not publish to npm, make the repository public, or create a release without explicit user approval.

## Cross-platform requirements

- Support macOS, Linux, and Windows as first-class platforms.
- Use Node.js and platform path/filesystem APIs; never hard-code path separators or require Bash, WSL, or POSIX utilities.
- Recognize directories, symbolic links, Windows junctions, and broken links without following unexpected targets.
- Represent external commands as argument arrays with explicit operating-system variants.
- Keep tests deterministic across case-sensitive and case-insensitive filesystems.
- CI must exercise supported Node versions on all three operating systems.

## Testing expectations

- The module interface is the primary test surface. Assert Inventory, RemovalPlan, QuarantineEntry, and ExecutionReport outcomes rather than implementation details.
- Every adapter includes isolated fixtures for discovery, ownership, removal planning, managed success, manager absence, managed failure, fallback, and verification.
- Safety tests must demonstrate that unrelated skills, plugin resources, System Skills, and Git-protected project files remain untouched.
- Failure tests must prove that dependent actions stop while independent actions can continue.
- JSON output and adapter schemas require deterministic snapshot or schema-validation coverage.
- Cross-platform filesystem behavior belongs in integration tests using temporary directories, not mocks that erase platform semantics.

## Git and release workflow

- Preserve unrelated user changes and keep commits scoped to the assigned issue.
- Prefer small, reviewable commits with messages that explain the delivered outcome.
- After completing and verifying a change, commit it and push its branch to the remote so it is available for review. Never push directly to `main`.
- Do not rewrite shared history or use destructive Git commands.
- The repository remains private until the user explicitly changes that decision.
- Issue #15 prepares release readiness but does not authorize npm publication or public visibility.

## Definition of done

A change is complete only when:

- Its issue acceptance criteria are satisfied.
- Relevant tests pass on supported platforms or any platform gap is explicitly documented.
- Safety invariants remain covered.
- Public interfaces and JSON shapes are documented.
- The worktree contains no temporary scripts, fixtures outside their intended locations, generated secrets, or unrelated edits.

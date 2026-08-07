# Contributing to skill-cleaner

`skill-cleaner` is specification-first. Start with the tracked issue and read
the linked sections of [`docs/spec.md`](./docs/spec.md),
[`CONTEXT.md`](./CONTEXT.md), [`docs/module-design.md`](./docs/module-design.md),
and the relevant [architectural decisions](./docs/adr/) before editing code.
When those sources disagree, reconcile the specification or record an ADR
instead of adding undocumented behavior.

## Development workflow

1. Confirm the issue's dependencies are closed.
2. Create an issue-scoped `feat/` branch; do not work directly on `main`.
3. Keep behavior behind the owning Inventory, Planning, Execution, Quarantine,
   or Adapter interface. The CLI and terminal UI remain thin callers.
4. Add observable tests through those interfaces using isolated temporary
   homes, workspaces, state directories, caches, and fake command runners.
5. Update public documentation and JSON schemas when an interface changes.
6. Run every local quality gate before opening a pull request:

   ```console
   npm run format:check
   npm run lint
   npm run typecheck
   npm test
   npm run build
   npm run pack:check
   ```

7. Push the branch and let the full macOS, Linux, and Windows CI matrix pass.

Pull requests should identify the issue, summarize the bounded outcome, list
the verification run, and call out any unresolved cross-platform or safety
risk. Preserve unrelated worktree changes and keep commits reviewable.

## Safety and portability

Never point tests at a developer's real Skill installations. Do not crawl a
real home directory, invoke an installed Manager, or use the repository's own
working tree as a removal target. Tests belong in temporary fixtures and must
not create read-only state.

Use Node.js path and filesystem APIs. Do not require Bash, WSL, POSIX utilities,
or a case-sensitive filesystem. External commands are structured executable
and argument arrays and never shell strings. Every mutation must preserve Git,
System Skill, dependency, Plugin-boundary, explicit-fallback, and Quarantine
guardrails from the accepted specification.

Security-sensitive findings should follow [`SECURITY.md`](./SECURITY.md), not a
public issue or ordinary pull request.

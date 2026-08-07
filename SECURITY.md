# Security policy

## Supported versions

No npm version has been released yet. Security fixes currently target the
latest commit on `main`. This table will be updated when the first version is
published.

| Version | Supported |
| --- | --- |
| Unreleased `main` | Yes |
| npm releases | None yet |

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include real local paths,
Inventory data, adapter contents, credentials, or exploit details in a public
pull request. Use GitHub's private vulnerability-reporting flow from the
repository Security tab when it is available. While the repository is private,
collaborators should contact the repository owner privately through GitHub and
request a private security advisory.

Include the affected version or commit, operating system and Node.js version,
the safety invariant involved, a minimal isolated reproduction, and the impact.
Use synthetic paths and fixtures wherever possible. Maintainers will validate
the report privately and coordinate disclosure after a fix is available.

## Security boundaries

Particularly sensitive areas include:

- path containment, links, junctions, and Git worktree protection;
- Adapter schema, content-hash trust, and structured command construction;
- exact package-runner approval and cleaner-owned execution state;
- Plugin ownership boundaries, dependencies, and explicit fallback;
- Quarantine integrity, restoration conflicts, and declarative record hashes;
- accidental telemetry, network transmission, or read-only state creation.

An Owner lifecycle process is a declared mutation boundary, not a portable
filesystem sandbox. See
[`docs/adr/0005-treat-owner-processes-as-declared-mutation-boundaries.md`](./docs/adr/0005-treat-owner-processes-as-declared-mutation-boundaries.md)
for the guarantee and limitation.

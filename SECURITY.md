# Security policy

## Supported versions

The current supported release line is `0.2.x`. Security fixes also support the
published `0.1.x` line when the fix applies to that line.

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `0.1.x` | Yes |
| `< 0.1.0` | No |

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include real local paths,
Inventory data, Adapter contents, credentials, or exploit details in a public
pull request. Use the repository's
[private vulnerability-reporting form](https://github.com/ukchucktown/lampwright/security/advisories/new).
If the form is unavailable, contact the repository owner privately through
GitHub and ask for a private security advisory; do not fall back to a public
issue.

Include the affected version or commit, operating system and Node.js version,
the safety invariant involved, a minimal isolated reproduction, and the impact.
Use synthetic paths and fixtures wherever possible. Maintainers will validate
the report privately and coordinate disclosure after a fix is available.

## Security boundaries

Particularly sensitive areas include:

- path containment, links, junctions, and Git worktree protection;
- Adapter schema, content-hash trust, and structured command construction;
- exact package-runner approval and Lampwright-owned execution state;
- Plugin ownership boundaries, dependencies, and explicit fallback;
- Quarantine integrity, restoration conflicts, and declarative record hashes;
- accidental telemetry, network transmission, or read-only state creation.

An Owner lifecycle process is a declared mutation boundary, not a portable
filesystem sandbox. See
[`docs/adr/0005-treat-owner-processes-as-declared-mutation-boundaries.md`](./docs/adr/0005-treat-owner-processes-as-declared-mutation-boundaries.md)
for the guarantee and limitation.

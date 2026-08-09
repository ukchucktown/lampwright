---
status: superseded by ADR-0012
---

# Adopt the Lampwright product name

The product, npm package, executable, repository, schemas, and user-facing
interfaces use the name **Lampwright** and the identifier `lampwright`. The name
better covers discovery, organization, reversible availability control, and
safe removal than the original cleanup-only name.

The package had not been published under its previous name, so no executable or
package-import alias is retained. The local-state compatibility portion of the
original decision is superseded by ADR 0012 after the maintainer explicitly
discarded all pre-release development state. This decision does not authorize
reserving or publishing the `lampwright` npm name.

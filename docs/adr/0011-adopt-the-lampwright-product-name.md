# Adopt the Lampwright product name without moving existing state

The product, npm package, executable, repository, schemas, and user-facing
interfaces use the name **Lampwright** and the identifier `lampwright`. The name
better covers discovery, organization, reversible availability control, and
safe removal than the original cleanup-only name.

The default local-state directory and the transaction, recovery, and claim
filename prefixes retain their original `skill-cleaner` identifier. Those
values are persisted compatibility boundaries rather than product branding.
Renaming them would make existing Trash, Disabled Storage, trust, and audit
data appear lost and could prevent recovery of an interrupted operation.
Lampwright therefore continues using those identifiers on macOS, Linux, and
Windows. Read-only operations remain zero-footprint and perform no migration.

The package had not been published under the previous name, so the old
`skill-cleaner` executable and package import are not retained as aliases. This
decision does not authorize reserving or publishing the `lampwright` npm name.

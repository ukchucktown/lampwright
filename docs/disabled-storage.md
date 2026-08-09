# Disabled Storage

Disabled Storage is the non-expiring, recoverable store used only by Suspended
Disable. It is deliberately separate from Quarantine and never appears in
Trash. It has no retention period and no purge operation.

The public module exposes `list`, `suspend`, `previewEnable`, and `enable`.
It intentionally exposes neither expiry nor purge.

`SuspendRequest` remains a compatibility union. The legacy version 1 shape has
one `location` and no explicit schema discriminator. Version 2 has
`schemaVersion: 2` and a nonempty `artifacts` tuple of `{ location }` values;
both shapes carry identity, nonempty Installation IDs, ownership, Harness
Exposures, and operation provenance. A version 2 `DisabledEntry` replaces the
single `originalLocation`/integrity/restoration fields with a nonempty
`artifacts` tuple whose members contain those three values. `list`, preview,
and Enable continue accepting persisted version 1 entries. Successful version
2 preview and Enable values retain the legacy primary `destination` and add the
complete ordered `destinations` tuple.

Each version 1 manifest records one legacy artifact. A version 2 manifest
records one nonempty, path-sorted artifact set. Both record:

- its opaque entry ID and suspension timestamp;
- every original `ArtifactLocation`, SHA-256 integrity value, and restoration
  metadata;
- Skill identity, Installation IDs, and ownership evidence;
- a nonempty, unique, harness-ID-sorted set of Harness Exposures;
- the approved operation ID and nonempty display provenance; and
- the mode and modification time needed for exact re-enablement.

Native Disable remains live harness configuration evidence and creates no
Disabled Storage entry. Entries created by one approved operation retain that
same operation provenance without being merged by name or content.

Suspension accepts a complete planner-authorized artifact set. Independently
filesystem-owned Installations contain one artifact; explicitly supported
Manager-owned Installations contain their primary and every declared
supplemental artifact while the Manager record remains unchanged. It refuses
Plugin, runtime/System, Git-protected, incomplete, overlapping, unsafe-state,
changed, or unsupported paths. Enable validates the persisted manifest and all
payload integrity, verifies Git protection again, and publishes only when every
original destination is free. It never overwrites a destination. Filesystem
displacement, cross-device copy, and enable publication are journaled as one
operation so an interrupted mutable call cannot be treated as fully disabled or
enabled when only part of the set moved. Recovery runs only at the start of a
mutating call; `list` and `previewEnable` never recover, create, or change state.
An occupied or changed path leaves the complete Disabled Storage entry retained.

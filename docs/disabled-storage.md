# Disabled Storage

Disabled Storage is the non-expiring, recoverable store used only by Suspended
Disable. It is deliberately separate from Quarantine and never appears in
Trash. It has no retention period and no purge operation.

The public module exposes `list`, `suspend`, `previewEnable`, and `enable`.
It intentionally exposes neither expiry nor purge.

Each version 1 manifest records:

- its opaque entry ID and suspension timestamp;
- the original `ArtifactLocation` and SHA-256 integrity;
- Skill identity, Installation IDs, and filesystem ownership evidence;
- a nonempty, unique, harness-ID-sorted set of Harness Exposures;
- the approved operation ID and nonempty display provenance; and
- the mode and modification time needed for exact re-enablement.

Native Disable remains live harness configuration evidence and creates no
Disabled Storage entry. Entries created by one approved operation retain that
same operation provenance without being merged by name or content.

Suspension accepts only independently filesystem-owned artifacts. It refuses
manager, plugin, runtime/System, Git-protected, unsafe-state, changed, or
unsupported paths. Enable validates the persisted manifest and payload
integrity, verifies Git protection again, and publishes only to a free original
destination. It never overwrites a destination. Filesystem displacement, cross-device
copy, and enable publication are journaled so an interrupted mutable operation
can be recovered without treating a partial result as enabled. Recovery runs
only at the start of a mutating call; `list` and `previewEnable` never recover,
create, or change state. A completed exact publication is finalized, a partial
directory publication resumes only from its entry-bound claim marker, and an
occupied or changed path is left untouched with its Disabled Storage entry
retained.

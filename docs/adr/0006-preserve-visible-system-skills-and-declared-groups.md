# Preserve visible System Skills and declared-only Installation Groups

System Skills remain visible in a dedicated terminal UI section, but are never selectable or removable. Visibility explains why an apparent capability cannot be cleaned without weakening the System Skill protection boundary.

A broken lock-only manager record can remain visible with empty agent exposure:
it is diagnostic evidence of manager state, not an active capability. This does
not weaken the non-empty exposure invariant for active Installations.

Installation Groups remain a navigational batch-selection aid, not an identity claim. V1 emits Groups only when an Owner record declares the Manager, source, and Scope together. Structural grouping is deferred: it may be reconsidered only with a concrete discovery path, observable fixtures, and a documented boundary for planning and force behavior.

The original decision to retain the TUI's section-preserving filter was
superseded by ADR 0008 after global search was prototyped and accepted. That
change does not alter System Skill protection, Installation Group identity,
pointer gestures, or removal eligibility.

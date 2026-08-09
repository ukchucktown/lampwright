# Use one canonical Lampwright state root on macOS and Linux

Lampwright uses the XDG state convention on both macOS and Linux, falling back
to `~/.local/state/lampwright`, and uses the `lampwright` application identifier
for Windows state and recovery markers as well. Pre-release development state
is intentionally not migrated: the maintainer discarded it, and keeping one
active location avoids hidden duplicate Trash, Disabled Storage, audit, and
trust stores while preserving zero-footprint read-only behavior.

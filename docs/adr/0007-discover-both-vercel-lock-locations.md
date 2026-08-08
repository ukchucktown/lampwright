# Discover both Vercel lock locations while preserving removal authority

Vercel `skills` resolves one global lock according to the current environment:
`$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set, or
`~/.agents/.skill-lock.json` otherwise. Inventory nevertheless discovers both
known locations because users can change that environment after installing
Skills, leaving a valid historical lock on disk.

The manager-resolved location remains authoritative for managed removal. A
record found only at the other location remains visible with its evidence and
may use its exact declarative fallback and Quarantine, but it must not claim
that the Manager can remove it. When both exist, Inventory prefers the
manager-resolved lock. Malformed candidate locks are surfaced rather than
silently skipped.

This separates bounded discovery from lifecycle authority without reverting to
a home-directory crawl or silently widening managed-removal capability.

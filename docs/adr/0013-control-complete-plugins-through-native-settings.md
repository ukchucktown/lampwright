# Control complete Plugins only through harness-native settings

Lampwright may disable or enable a non-default Plugin only as one complete
Plugin boundary through materialized, exact-preimage harness-native control.
Owned Skills and resources remain installed under the complete owner gate;
their rows stay read-only, and Plugin availability never falls back to Disabled
Storage. This preserves the Plugin as the lifecycle authority, avoids pretending
that child files are independently controllable, and keeps removal independent
from availability. Runtime-default, managed-policy, unsupported, unresolved,
malformed, ambiguous, protected, read-only, stale, or raced controls therefore
fail closed rather than triggering filesystem displacement.

[ADR 0015](./0015-scope-session-setup-to-native-availability.md) narrows the
read-only child rule for Session setup: a verified native MCP or app policy may
change independently. Plugin-owned Skills remain read-only, and a complete
Plugin action preserves independent child policies.

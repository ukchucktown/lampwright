# Control complete Plugins only through harness-native settings

Lampwright may disable or enable a non-default Plugin only as one complete
Plugin boundary through materialized, exact-preimage harness-native control.
Owned Skills and resources remain installed and change availability together;
their rows stay read-only, and Plugin availability never falls back to Disabled
Storage. This preserves the Plugin as the lifecycle authority, avoids pretending
that child files are independently controllable, and keeps removal independent
from availability. Runtime-default, managed-policy, unsupported, unresolved,
malformed, ambiguous, protected, read-only, stale, or raced controls therefore
fail closed rather than triggering filesystem displacement.

# Treat Owner processes as declared mutation boundaries

`skill-cleaner` will constrain every process invocation it constructs to a
validated executable and argument array, use no shell, and authorize an Owner
operation only after a fresh plan confirms every declared remove-path and
modify-path effect remains outside Git and System Skill protection. Ephemeral
`npx` acquisition runs from cleaner-owned local state with an isolated npm
cache, never from the user's project, and uses the exact approved package
version. Direct and ephemeral Owner invocations receive cleaner-owned
`DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` values so supported managers do not
transmit removal metadata; Adapters cannot supply or override process
environment values.

Node.js does not expose a filesystem sandbox that can confine an arbitrary
child process portably across macOS, Linux, and Windows. Operating-system
facilities such as sandbox-exec profiles, namespaces, containers, restricted
tokens, and job objects have different guarantees and availability. Requiring
one would either make the supported platforms unequal or create a second,
privileged execution system.

The declared effect set is therefore the safety and audit boundary for a
trusted Owner lifecycle operation, not a claim that the cleaner can mediate
every system call made by that Owner. Execution passes only the reviewed
invocation, performs no direct mutation outside Quarantine or an exact
declarative record action, rescans live Inventory after the process exits, and
reports verification failures rather than claiming success. An Adapter must
not under-declare known effects; such an Adapter is incorrect and its exact
content hash must be trusted again after correction.

This limitation does not weaken cleaner-owned mutations. Quarantine and record
cleanup remain bound to exact planned paths, hashes, records, and fresh Git
protection. `--force` never expands the effect set, approves Adapter or package
trust, or bypasses project and System Skill protection.

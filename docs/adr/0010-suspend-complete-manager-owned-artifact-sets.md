# Suspend complete Manager-owned artifact sets without changing Manager state

When a Manager-owned Skill has an unsupported Harness Exposure, `lampwright`
may use Suspended Disable only if Inventory explicitly enumerates the complete
primary and supplemental discovery artifact set. Disabled Storage treats that
set as one reversible operation while preserving the Manager record; this keeps
Disable useful for multi-harness Managers without pretending an uninstall is a
disable. The rejected alternatives were blocking all Manager-owned Skills or
moving only the primary path, which respectively defeats the feature or leaves
the capability partly available. A Manager-created replacement is therefore an
Enable conflict, never authority to overwrite or merge content.

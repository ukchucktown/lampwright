# Keep Disabled Storage separate from Quarantine

Suspended Disable will use a dedicated non-expiring Disabled Storage module rather than representing disabled Installations as Quarantine entries. Quarantine is evidence of Brute-force Removal and supports retention and permanent purge, while a disabled Installation is intentionally retained until Enable restores it; sharing those semantics would let routine Trash actions permanently delete content that the user never chose to remove. Native disabled state remains live harness evidence and does not create a Disabled Storage entry.

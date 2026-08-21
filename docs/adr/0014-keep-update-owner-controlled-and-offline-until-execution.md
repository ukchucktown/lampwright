# Keep Update Owner-controlled and offline until execution

Lampwright uses only a supported Owner lifecycle operation to update an existing Installation or complete Plugin boundary. It does not construct Update from filesystem replacement or from Remove followed by Install. Inventory, browse, Planning, and dry-run use local evidence and do not contact remote sources. The reviewed Owner operation can access the network during Execution. This choice preserves ownership and zero-footprint review, but it defers generic filesystem Update, remote update badges, and automatic rollback.

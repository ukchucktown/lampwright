# Use stateless live inventory and declarative adapters

`skill-cleaner` will rebuild its Inventory from live filesystem and Owner evidence on every run instead of maintaining an installation database. Tool-specific support is expressed through versioned local JSONC Adapters rather than executable extension code, which keeps ownership pluggable without creating another code-loading ecosystem or a registry that can drift from the systems being cleaned.

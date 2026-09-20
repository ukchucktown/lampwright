# Scope Session setup to explicit native availability

Session setup selects one harness and workspace context through a distinct native-only intent, while legacy Availability keeps its all-exposure Skill behavior. This separation prevents a setup filter from silently changing lifecycle meaning or authorizing filesystem suspension, and it makes a wider user-scope policy visible before confirmation.

A verified native policy may independently control a package-provided MCP Registration or App Binding. This narrowly refines [ADR 0013](./0013-control-complete-plugins-through-native-settings.md): complete Plugin actions still control the owner gate, Plugin-owned Skills remain read-only, and independent child policies survive an owner change. A disabled owner blocks child Enable unless the user explicitly includes an owner Enable in the same reviewed plan.

The retired unmerged MCP plan at commit `229f8cd` has no authority here. In particular, its permanent-registration-deletion draft does not apply. Session setup preserves installed definitions and credentials, has no delete or suspension operation, and makes no claim about an active session's context or exact token savings. [The implementation contract](../session-setup.md) defines the scope, compatibility, and verification consequences.

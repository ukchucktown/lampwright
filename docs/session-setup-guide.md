# Session setup operator guide

Session setup limits the capabilities that a supported harness exposes before
you start a new agent session. It changes native availability policy and keeps
the installed definitions, credentials, and package files.

Use Session setup when you want a smaller active set of Skills, Plugins, MCP
servers, or Apps. A smaller set can reduce loaded capability metadata. The
actual token effect depends on the harness, and Lampwright does not measure or
promise a token reduction.

## Terminal UI procedure

1. Start Lampwright with the workspace that the next agent session will use.

   ```console
   lampwright --workspace /path/to/workspace
   ```

2. Press `ctrl-o` to open **Session setup**.
3. Select Codex, Claude Code, or Gemini CLI in the left pane.
4. Press `ctrl-t` to switch between the enabled and disabled setup views.
5. Focus a target in the right pane.
6. Press `d` to review Disable, or press `e` to review Enable.
7. Read the control scope, the owner effects, the dependencies, and the
   activation requirement.
8. Press `y` only when the complete plan is correct.
9. Press Enter or Escape on the result to scan the setup sources again.
10. Start a new harness session after a successful change.

The setup area keeps a separate position and selection for each harness and
view. Enter on a setup row opens details. It does not start a removal. Use
`ctrl-o` to return to the **Skills & plugins** lifecycle area.

## CLI procedure

1. Scan the selected harness and save the exact target ID.

   ```console
   lampwright scan --session-setup --harness codex --workspace /path/to/workspace --json
   ```

2. Review a complete plan without a configuration change.

   ```console
   lampwright disable setup:<target-id> --harness codex --workspace /path/to/workspace --dry-run
   ```

3. Apply the reviewed plan.

   ```console
   lampwright disable setup:<target-id> --harness codex --workspace /path/to/workspace --yes
   ```

Use `enable` with the same selector form to enable a target. A setup mutation
requires one harness and exact target IDs from the current setup snapshot. A
mixed setup and lifecycle command is invalid.

## Supported terminal profiles

| Harness profile | Supported local targets | Control scope | Activation |
| --- | --- | --- | --- |
| Codex CLI `0.154.0` | Standalone Skills, complete Plugins, standalone and Plugin MCP servers, and installed App bindings | A trusted workspace policy when the native contract supports it. Otherwise, the plan discloses a user-wide policy. | Start a new session. |
| Claude Code terminal `2.1.270` | Local Skills, complete Plugins, and local or Plugin MCP servers | A safe local workspace override before a user policy. MCP availability uses the selected project preference in the Claude user-state document. | Start a new session. |
| Gemini CLI `0.59.0` | Standalone Skills, installed extensions, and standalone or extension MCP servers | A trusted workspace policy for Skills and extensions when available. MCP policy uses the native user-wide server name. Enable can change every applied disabling layer. | Start a new session. |

The profile version identifies the qualified source contract. It does not
claim support for every older or newer client version. An unknown version or
document shape leaves the affected control unavailable.

## Policy and effective state

Each target shows its configured policy and its effective state in the
selected workspace. An owner gate, a higher-precedence layer, or a workspace
trust decision can make these values different.

The review names a workspace effect or a user-wide effect before confirmation.
One native selector can govern several known declarations. In that case, the
review lists the shared collateral. A required capability blocks Disable unless
the same plan can preserve the dependency.

## Unsupported and unknown surfaces

Lampwright reports unsupported and unknown state explicitly:

- Claude account connectors have no qualified offline control. Use the native
  `/mcp` or account-management route.
- Gemini account Apps have no qualified control.
- Codex App policy does not prove that an account connection works.
- Codex desktop, Claude desktop, and other desktop clients have no qualified
  profile in this increment.
- An active agent session can keep its prior capability set. Lampwright does
  not reload or reconnect that session.
- Session setup does not delete an MCP definition, disconnect an account,
  remove a Plugin, suspend files, or install an owner.

## Evidence boundaries

The native profiles describe qualified local source formats, precedence, and
availability controls. The adapter tests use isolated homes, workspaces, state
roots, caches, and process runners. They verify both policy directions and the
preservation of unrelated content.

The real-terminal acceptance check runs the built Lampwright interface against
isolated local fixtures. It verifies interaction, layout, resize, pointer, and
plain-text behavior. It does not prove live account connectivity or invoke a
Codex, Claude Code, or Gemini CLI agent session.

See [Session setup controls](./session-setup-controls.md) for the complete
source matrix. See [Session setup acceptance](./session-setup-acceptance.md)
for the current test and terminal evidence.

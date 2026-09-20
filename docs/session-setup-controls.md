# Session setup controls

This document defines the native profiles that the [Session setup plan](./session-setup.md) must qualify. The recovered branch provides source baselines, not tested support for every installed desktop or CLI version. No version range follows from a documentation date.

## Evidence and qualification

The recovered baselines are Codex `0.154.0`, Claude Code `2.1.270`, and Gemini CLI `0.59.0`. The old standalone Codex work also references `0.46.0`. The new increment does not require that older profile. Existing Skill and complete-Plugin controls remain documented in [Native availability controls](./availability-controls.md). The qualified Codex and Claude Code profiles apply to their terminal clients. Compatible desktop behavior remains a documented gap until separate desktop evidence qualifies it.

Every new profile records the harness/client surface, exact source version or schema signature, precedence, trust, definition scope, control scope, native selector, effects, activation boundary, and isolated fixture coverage. A CLI version alone does not prove the desktop runtime's capabilities. An unknown runtime or unsupported document shape keeps affected operations unavailable. Readable declarations may remain inspectable.

The profile can authorize a configuration-format contract independently of a CLI binary only when authoritative evidence proves that contract applies to the selected client. It must state that evidence explicitly. A native command requires its own exact tested version and bounded offline effects. The default fixture baseline is not a claim that the version is current.

## Planned matrix

| Harness and surface                     | Source and policy                                                                                                                                                                    | Scope and behavior                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI: Skill                        | A standalone Installation and ordered `skills.config` entries in user `config.toml`                                                                                                  | Exact Skill path, one harness. User configuration can affect other projects. The existing profile does not authorize project Skill rules.                                                      |
| Codex: complete Plugin                  | An authoritative installed-owner record plus `plugins.<id>.enabled`                                                                                                                  | User control in the initial profile. The owner gate preserves independent child policies. Workspace-managed or inseparable content remains protected.                                          |
| Codex: standalone MCP                   | User `config.toml` and the selected project's `.codex/config.toml`, with native `mcp_servers.<key>.enabled`                                                                          | Trusted project precedence where proven. A safe project override is preferred. Otherwise the review discloses the user-wide effect. Unknown trust or contributing policy blocks the operation. |
| Codex: Plugin MCP                       | An installed owner's inline, referenced, or default MCP declaration plus `plugins.<id>.mcp_servers.<server>.enabled`                                                                 | Exact native Plugin/server identity. Initial policy writes use user configuration. The manifest and sibling policies remain unchanged.                                                         |
| Codex: App Binding                      | An installed owner's supported inline or referenced app descriptor, including `.app.json`, plus `apps.<connector-id>.enabled`                                                        | User-wide connector policy. The review includes all known local aliases/owners that share the connector ID. Account authorization remains unknown.                                             |
| Claude Code terminal: Skill             | Native `skillOverrides` evidence for the selected exposure                                                                                                                           | Safe local project override before user scope. Shared project configuration is evidence only. Collisions across Skill Identities block.                                                        |
| Claude Code terminal: complete Plugin   | Versioned installed-owner registry and `enabledPlugins` configuration                                                                                                                | Safe local project override before user scope. The owner gate preserves independent server policy.                                                                                             |
| Claude Code terminal: MCP               | User/local definitions in `~/.claude.json`, project `.mcp.json`, or a proven installed Plugin declaration. Persistent availability uses the selected project's `disabledMcpServers`. | Project preference in the user state document. Approval through `enabledMcpjsonServers` or `disabledMcpjsonServers` remains separate. Plugin servers need the exact native namespaced key.     |
| Claude account connectors               | No qualified authoritative offline provider in this increment                                                                                                                        | An unavailable-source status and native `/mcp` or account-management route. Historical names never become actionable registrations.                                                            |
| Gemini CLI: Skill                       | `skills.disabled` in applied user and trusted-workspace settings                                                                                                                     | Disable prefers the safe selected-workspace layer. Enable removes membership from every applied disabling layer and discloses any user-wide effect.                                            |
| Gemini CLI: extension                   | Installed extension records/manifests and `extensions/extension-enablement.json`                                                                                                     | Use the proven workspace override for a selected workspace. Preserve other override rules. The existing lifecycle user-scope path remains unchanged.                                           |
| Gemini CLI: MCP                         | User/workspace settings or a proven installed extension manifest, plus `mcp-server-enablement.json`                                                                                  | The recovered profile uses a user-wide native name selector. Enable removes only the exact disabled preference. Standalone/extension collisions require authoritative resolution or a block.   |
| Gemini account apps and other harnesses | No qualified profile                                                                                                                                                                 | Explicitly unsupported. This plan does not fabricate an equivalent Codex App Binding for other products.                                                                                       |

The matrix is the required implementation scope. An adapter issue cannot claim completion when a fixture-only provider substitutes for a required supported local source. If authoritative evidence contradicts a row, the issue must reconcile this document before implementation. A missing account provider does not block the supported local sources.

All setup reports require a new session, restart, or an explicit statement that activation timing is unknown for that profile. File verification never claims that an active desktop task reloaded its tools. This increment does not invoke reload, reconnect, or session-only controls.

## Definition and owner evidence

Installed-owner evidence must establish the active root. A cache folder or source repository alone never establishes installation. Bounded manifest access checks owner containment, links, hard links, file stability, and Git protection. Inline and referenced declarations retain their exact source identities. Equal names, connector IDs, URLs, or hashes never merge declarations.

A Codex remote-installed Plugin can expose a local descriptor. That descriptor is eligible only when a verified installed-owner source establishes its root without an online request. Account inventory, installed package evidence, and connected account state remain separate. Unsupported owner-list variants remain visible as incomplete sources.

Availability evidence includes every applied layer and the intended safe writable layer. It includes exact document identity and preimage checks but excludes secret values from public data. An absent ordinary configuration file is an empty snapshot only when its parents and intended creation path pass the same safety checks. Discovery never creates it.

The selected workspace limits evaluation, not the meaning of a native user-wide policy. App policies keyed by connector ID can intentionally affect several bindings. Other ambiguous name selectors cannot borrow this exception. Incomplete owner, collision, or precedence evidence blocks a mutation that needs those facts.

## Native operations

The initial Codex and Claude profiles use checked native-format edits for availability. Gemini can use a qualified native command or a checked native-format edit, with the chosen method fixed in the plan. The new profile should reuse the existing safe configuration writer where its operation fits.

An operation changes only a Boolean policy, exact list membership, or the documented availability override. Removal of a Gemini disabled preference is a native Enable operation. It does not authorize deletion of the MCP registration. The new mutation union has no general-purpose remove or credential effect.

Every profile proves that Enable and Disable preserve authentication, unrelated server records, package definitions, and non-target policy. Commands use an executable and argument array. Missing binaries, native failure, unsupported versions, or failed verification produce an explicit result. They never trigger an automatic alternative method.

## Required fixtures

Each harness profile covers discovery, ownership, Enable, Disable, already-satisfied policy, missing commands, native failure, unsupported formats/versions, verification failure, and unrelated-target preservation. An unsupported fallback remains unavailable in fixtures.

Shared fixtures cover user/project precedence, trusted/untrusted/unknown workspaces, policy-managed and runtime-default targets, disabled owners, owner Enable with child policy disabled, required app bindings, shared connector aliases, and malformed or partial source results. Configuration fixtures also cover duplicate keys, case sensitivity, home/workspace aliases, links/junctions/broken links, hard links, CRLF, comments, races, and missing files. Secret sentinels never appear in snapshots, reports, logs, or errors.

The integration suite uses temporary filesystem roots on supported Node versions for macOS, Linux, and Windows. Native-format fixture tests and real-client acceptance evidence have separate labels. The final issue records any client or platform gap. A fake process runner never proves a successful live test.

## Sources and recovered evidence

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex MCP and Plugin policy](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex Skill controls](https://learn.chatgpt.com/docs/build-skills)
- [Codex local Plugin configuration](https://developers.openai.com/plugins/build/plugins#enable-or-disable-a-plugin-for-a-repo)
- [Recovered Codex source profile](https://github.com/ukchucktown/lampwright/blob/229f8cd3af49c374a7dc92b4f1f9782b1a7fea23/docs/codex-mcp.md)
- [Claude Code persistent MCP preferences](https://code.claude.com/docs/en/mcp#disable-a-server-without-removing-it)
- [Claude Code Plugin controls](https://code.claude.com/docs/en/discover-plugins#manage-installed-plugins)
- [Gemini MCP controls](https://geminicli.com/docs/tools/mcp-server/)
- [Gemini extension controls](https://geminicli.com/docs/extensions/reference/)
- [Recovered Claude and Gemini source profiles](https://github.com/ukchucktown/lampwright/blob/229f8cd3af49c374a7dc92b4f1f9782b1a7fea23/docs/claude-gemini-mcp.md)

The discovery and control contracts in the retired branch contain useful evidence but also deletion-specific behavior. The reuse manifest must identify exact adopted pieces and their new fixture coverage. A whole-branch merge would reintroduce abandoned product behavior.

---
schemaVersion: 1
provider: "github"
stableBranch: "main"
integrationBranchPattern: "feat/issue-{issue}-{slug}-integration"
childBranchPattern: "feat/issue-{issue}-{slug}"
worktreeRetention: "feature"
closeChildOnIntegrationMerge: true
autoMergeChildPullRequests: true
childMergeMethod: "squash"
featureMergeMethod: "merge"
childValidationCommands: [{"executable":"npm","args":["run","format:check"]},{"executable":"npm","args":["run","lint"]},{"executable":"npm","args":["run","typecheck"]},{"executable":"npm","args":["test"]}]
featureValidationCommands: [{"executable":"npm","args":["run","format:check"]},{"executable":"npm","args":["run","lint"]},{"executable":"npm","args":["run","typecheck"]},{"executable":"npm","args":["test"]}]
finalMergeApproval: "required"
featureLabel: "sdlc:feature"
childLabel: "sdlc:child"
readyLabel: "ready-for-agent"
---

# SDLC workflow

This repository uses coordinated feature branches for large efforts. GitHub
issues and native dependencies hold shared workflow state. Local worktrees and
agent harness settings remain machine preferences.

The root `AGENTS.md` contains the short instruction pointer. The installed
`sdlc-*` skills define the complete lifecycle.

# Release readiness and manual publication

Status: GitHub release preparation for `0.1.1`; npm publication remains pending.
This document does not authorize a Git tag, npm publication, or GitHub release;
each external release action still requires the maintainer's explicit approval.

## Verified release model

The release configuration follows these current primary-source requirements:

- npm recommends `npm pack --dry-run` to inspect exactly which files will be
  published, and a `files` allowlist limits package contents. See
  [npm publish: files included in package](https://docs.npmjs.com/cli/publish/#files-included-in-package).
- npm trusted publishing uses workflow-scoped OIDC credentials instead of a
  long-lived write token. It currently requires npm 11.5.1 or newer, Node.js
  22.14.0 or newer, a GitHub-hosted runner, `id-token: write`, and an exact
  repository/workflow configuration. See
  [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/).
- Trusted publishing automatically generates provenance for a public package
  built from a public repository. npm explicitly does not support provenance
  from a private repository. See
  [npm trusted publishing: automatic provenance](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation)
  and [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/).
- A first public package can use `npm publish --provenance --access public`
  from a GitHub-hosted workflow with an npm token; after the package exists,
  its settings can name the exact trusted-publisher workflow. See
  [GitHub's npm publishing workflow](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages#publishing-packages-to-the-npm-registry).
- Staged publishing can add a later human 2FA approval, but it requires npm
  11.15.0 or newer and an already-existing package. See
  [Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing/).
- GitHub states that a full commit SHA is the only immutable way to consume an
  action. Every release and CI action is pinned accordingly. See
  [GitHub Actions secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).
- A GitHub environment can require reviewers and restrict deployment tags
  before a publish job runs. See
  [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

As rechecked on 2026-08-21, `lampwright@0.1.0` exists on npm with provenance,
private vulnerability reporting is enabled, and the `npm-production` GitHub
environment exists. `0.1.1` remains unpublished. Recheck these point-in-time
facts immediately before tagging and publishing. The checked-in publish
workflow also verifies the canonical public repository so it cannot emit a
provenance-less release from another checkout.

## Automated evidence

`npm run pack:check` builds from source, asks npm for the dry-run pack list, and
fails unless exactly one package and only files within the documented allowlist
are returned. It accepts the npm 11 result array and npm 12 lifecycle object,
then applies the same strict name, version, exports, schemas, executable
shebang, and content checks. The package must include these `0.1.1` release
notes and exclude source, tests, scripts, logs, environment files, and
`node_modules`.

The manually dispatched `release-candidate.yml` workflow runs every quality
gate on a GitHub-hosted Node 24 runner, creates the actual tarball and a SHA-256
digest, and retains both as one review artifact. It never publishes.

The manually dispatched `publish.yml` workflow requires all of the following
before its publish step is reachable:

- an exact `lampwright@<version>` confirmation input;
- the matching `v<version>` Git tag;
- the canonical `ukchucktown/lampwright` repository;
- a public repository, Node.js 22.14 or newer, and npm 11.15.0;
- the `npm-production` GitHub environment;
- a fresh install, every source gate, and the package-content audit.

It then runs only `npm publish --provenance --access public`. The workflow has
read-only repository permission plus the OIDC permission required for
provenance. It has no automatic push, tag, or release trigger.

## MVP evidence matrix

| Specification acceptance criterion | Evidence |
| --- | --- |
| 1. `npx` on macOS, Linux, Windows | The CI matrix runs Node 20/22/24 on all three systems; built-executable tests are in [`tests/cli.test.ts`](../tests/cli.test.ts), and `pack:check` verifies the npm bin. |
| 2. Zero-footprint generic, Vercel, Claude Code, Codex, Gemini Inventory | [`tests/inventory.test.ts`](../tests/inventory.test.ts), [`tests/vercel-skills.test.ts`](../tests/vercel-skills.test.ts), [`tests/claude-code-plugins.test.ts`](../tests/claude-code-plugins.test.ts), [`tests/codex-plugins.test.ts`](../tests/codex-plugins.test.ts), and [`tests/gemini-cli.test.ts`](../tests/gemini-cli.test.ts). |
| 3. TUI fuzzy search and logical/physical selection | [`tests/tui.test.ts`](../tests/tui.test.ts). |
| 4. Ownership, dependency, Plugin impact, Git, exact actions | [`tests/planning.test.ts`](../tests/planning.test.ts) plus the plan rendering interactions in [`tests/tui.test.ts`](../tests/tui.test.ts). |
| 5. Supported Owner removal | Managed success suites in every built-in adapter test and the overlapping path in [`tests/end-to-end.test.ts`](../tests/end-to-end.test.ts). |
| 6. No silent fallback | Execution and adapter failure suites, plus the two-plan assertion in [`tests/end-to-end.test.ts`](../tests/end-to-end.test.ts). |
| 7. Brute-force Quarantine and restore | [`tests/quarantine.test.ts`](../tests/quarantine.test.ts) and the real fallback/restore path in [`tests/end-to-end.test.ts`](../tests/end-to-end.test.ts). |
| 8. Git and System Skill immutability, including force | [`tests/inventory.test.ts`](../tests/inventory.test.ts), [`tests/planning.test.ts`](../tests/planning.test.ts), and [`tests/execution.test.ts`](../tests/execution.test.ts). |
| 9. Local JSONC Adapters | Schema, compilation, trust, and Inventory integration in [`tests/adapter.test.ts`](../tests/adapter.test.ts) and [`tests/inventory.test.ts`](../tests/inventory.test.ts). |
| 10. Stable non-interactive JSON | Schema validation and deterministic snapshots in [`tests/cli.test.ts`](../tests/cli.test.ts). |
| 11. Final rescan verification | Fresh-plan, rescan-error, and verification branches in [`tests/execution.test.ts`](../tests/execution.test.ts). |
| 12. Unrelated artifacts untouched | Adapter safety suites and the overlapping dry-run, managed, and fallback snapshots in [`tests/end-to-end.test.ts`](../tests/end-to-end.test.ts). |
| 13. Native and suspended Disable can be enabled | User and workspace Codex/Claude/Gemini round-trips and generic suspension in [`tests/availability-planning-execution.test.ts`](../tests/availability-planning-execution.test.ts); artifact types and recovery in [`tests/disabled-storage.test.ts`](../tests/disabled-storage.test.ts). |

## Availability evidence matrix

| Availability risk or outcome | Evidence |
| --- | --- |
| User and workspace Native round-trip | Codex, Claude Code, and Gemini loops in [`tests/availability-planning-execution.test.ts`](../tests/availability-planning-execution.test.ts), preserving comments, CRLF, unrelated values, and applicable document scope. |
| Suspended file, directory, link, broken link, and junction | Real temporary filesystem and neutral Windows-junction seam cases in [`tests/disabled-storage.test.ts`](../tests/disabled-storage.test.ts). |
| Case and cross-volume behavior | Host-sensitive case collision plus verified-copy/no-cross-volume-rename cases in [`tests/disabled-storage.test.ts`](../tests/disabled-storage.test.ts). |
| Zero-footprint scan, browse, plan, and dry run | Inventory zero-footprint in [`tests/inventory.test.ts`](../tests/inventory.test.ts), Disabled list/preview in [`tests/disabled-storage.test.ts`](../tests/disabled-storage.test.ts), TUI browse/review in [`tests/tui-disabled.test.ts`](../tests/tui-disabled.test.ts), and CLI dry run in [`tests/cli-availability.test.ts`](../tests/cli-availability.test.ts). |
| Absolute force-resistant protection | Ownership, Plugin/System, Git/configuration protection, reoccupied paths, same-name collisions, and dependency force boundaries in [`tests/availability-planning-execution.test.ts`](../tests/availability-planning-execution.test.ts). |
| Unrelated settings and owned state | Native round-trips preserve comments and unrelated settings; force-resistant fixtures keep unrelated Skills, Plugin/System identities, Manager ownership, occupied replacements, and protected configuration untouched in [`tests/availability-planning-execution.test.ts`](../tests/availability-planning-execution.test.ts). |
| Races, stale/forged plans, collisions, integrity | Availability execution and Disabled recovery suites in [`tests/availability-planning-execution.test.ts`](../tests/availability-planning-execution.test.ts) and [`tests/disabled-storage.test.ts`](../tests/disabled-storage.test.ts). |
| Partial branches and final rescan failure | Independent/dependent action scheduling and typed rescan failure reports in [`tests/availability-planning-execution.test.ts`](../tests/availability-planning-execution.test.ts). |
| CLI JSON and every TUI state | Schema/envelope/exit-code coverage in [`tests/cli-availability.test.ts`](../tests/cli-availability.test.ts) and Disabled browse/review/execution/report/navigation in [`tests/tui-disabled.test.ts`](../tests/tui-disabled.test.ts). |
| Public exports, package, schemas, platform matrix | `pack:check`, [`tests/release-readiness.test.ts`](../tests/release-readiness.test.ts), and Node 20/22/24 on Ubuntu/macOS/Windows in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). |

The issue #15 fixture additionally exercises same-name generic, Manager-owned,
and Plugin-owned Installations; missing Manager/ephemeral acquisition; managed
success and failure; explicit fallback; Quarantine and restoration; broken
links; Git protection; a System Skill; Plugin collateral; and unrelated files.
Specialized adapter suites retain deterministic coverage for stale records,
duplicate native names, Manager absence without an eligible runner, and
platform-specific links and junctions.

## Reproducible dry-run demonstration

Run this from a clean checkout:

```console
npm ci
npx vitest run tests/end-to-end.test.ts -t "keeps scan and dry-run completely read-only"
```

The test builds only temporary homes, workspaces, state roots, caches, Manager
records, Plugins, links, and Git evidence. It snapshots the complete fixture
before scanning and Planning, then requires a byte-identical snapshot
afterward. It separately reads the unrelated Installation, Plugin collateral,
and Git-protected project Skill and proves no Lampwright state root exists.

## Manual release checklist

Preparation (safe before publication):

- [ ] Confirm GitHub private vulnerability reporting is enabled and that
      [`SECURITY.md`](../SECURITY.md) points to the working private form.
- [ ] Create the `npm-production` GitHub environment and restrict deployments
      to the intended release-tag pattern. Add an eligible independent reviewer
      or a wait timer when useful; a sole maintainer's own confirmation is not
      independent approval.
- [ ] Confirm the npm owner account has two-factor authentication enabled.
- [ ] Recheck npm metadata and confirm `package.json`, the lockfile, these
      [`0.1.1` release notes](./releases/0.1.1.md), expected CLI output, and the
      intended `v0.1.1` tag all agree.
- [ ] Freeze the intended release commit. Run `npm ci` and every local quality,
      package, runtime-dependency, and full-dependency gate from a clean
      checkout; resolve every release blocker.
- [ ] Confirm the Node 20/22/24 macOS/Linux/Windows CI matrix is green for that
      exact commit.
- [ ] Dispatch `Release candidate` at the frozen commit. Download the tarball
      and SHA-256 file, verify the digest, unpack the package, and inspect it for
      secrets, development artifacts, stale names, unintended files, and
      misleading documentation.
- [ ] Install that exact tarball in a clean temporary location. Run
      `lampwright --version`, `lampwright --help`, and representative read-only
      commands, then accept or reject the candidate without rebuilding it.
- [ ] Review npm's public-transparency-log notice linked by the provenance
      documentation.

GitHub patch release (manual and separately authorized):

1. Obtain explicit approval to create and push the signed `v0.1.1` tag at the
   accepted candidate commit. Verify the remote tag points to that commit.
2. Create the GitHub `v0.1.1` release from that tag using the reviewed
   [`0.1.1` release notes](./releases/0.1.1.md), then verify its tag and commit.
3. Only after the GitHub release is verified, obtain separate explicit approval
   to publish `lampwright@0.1.1`.
4. Dispatch `Publish to npm` from the exact tag, enter the exact package
   confirmation `lampwright@0.1.1`, and enter `v0.1.1` as the GitHub release
   confirmation. Satisfy the configured environment gate.

Post-publication verification and credential cleanup:

1. Verify `npm view lampwright@0.1.1`, the npm package-page metadata, and
   `npx lampwright@0.1.1 --version` and `--help` from clean environments.
2. Verify provenance and signatures with a current npm CLI using
   `npm audit signatures`, and capture macOS, Linux, and Windows smoke evidence.
3. Configure npm trusted publishing for owner `ukchucktown`, repository
   `lampwright`, workflow `publish.yml`, environment `npm-production`, and the
   publish action. Verify the OIDC path on supported Node/npm versions.
4. Verify the trusted-publishing workflow and restrict traditional token
   publishing; no bootstrap publication token is part of this patch flow.
5. For later versions, consider stage-only publishing so the maintainer can
   inspect and approve the staged package with 2FA.

Preparation and candidate review do not authorize `npm publish`, a publish
workflow dispatch, a Git tag, or a GitHub release.

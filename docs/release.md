# Release readiness and manual publication

Status: release-ready verification for `0.1.0`; no npm publication or repository
visibility change is authorized by this document or issue #15.

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

As verified on 2026-08-09, the GitHub repository is public and
`npm view lampwright` returns `E404`. Do not reserve or publish the name
now; recheck its availability only at explicitly approved release time. The
checked-in publish workflow deliberately rejects a private
repository, so it cannot emit a provenance-less release. Changing visibility
and publishing remain separate, explicit maintainer decisions.

## Automated evidence

`npm run pack:check` builds from source, asks npm for the dry-run pack list, and
fails unless every file is within the documented allowlist. It verifies all
exports, schemas, the executable shebang, release documentation, and the absence
of source, tests, scripts, logs, environment files, and `node_modules`.

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

- [ ] Obtain explicit approval to make the repository public and publish the
      named npm version. Do neither as an implied part of release readiness.
- [ ] Confirm the package name is still available and `package.json` version,
      changelog/release notes, and intended `v<version>` tag agree.
- [ ] Run all six local quality commands from `CONTRIBUTING.md` after `npm ci`.
- [ ] Dispatch `Release candidate` at the exact release commit; download the
      tarball and digest, verify SHA-256, unpack it, and inspect the allowlisted
      contents and executable behavior.
- [ ] Confirm the full macOS/Linux/Windows CI matrix is green from a clean
      checkout and dependency/security review has no unresolved release block.
- [ ] Enable GitHub private vulnerability reporting before public visibility.
- [ ] Create and configure the `npm-production` GitHub environment with a
      required reviewer and tag restriction where the repository plan supports
      those controls.
- [ ] Review the public-transparency-log notice linked by npm's provenance
      documentation.

First publication (manual and separately authorized):

1. Make the repository public only after the explicit visibility approval.
2. Create the signed `v<version>` tag at the reviewed commit and push that tag.
3. Because `lampwright` does not yet exist on npm, create a short-lived,
   narrowly scoped `NPM_TOKEN` suitable for the bootstrap publication, require
   account 2FA, and store it only as the `npm-production` environment secret.
4. Dispatch `Publish to npm` from the exact tag and type the exact
   `lampwright@<version>` confirmation. Approve the protected environment.
5. Verify the registry package, install it in a fresh temporary project, run
   `npx lampwright --version` and `--help`, and verify its attestation with a
   current npm CLI (`npm audit signatures`).
6. Delete the bootstrap token immediately. In the npm package settings,
   configure GitHub Actions trusted publishing for organization/user
   `ukchucktown`, repository `lampwright`, workflow `publish.yml`, and the
   `npm-production` environment. Restrict or disallow traditional publish
   tokens after the OIDC path is verified.
7. For later versions, consider changing the trusted publisher and workflow to
   stage-only publishing so a maintainer must inspect and approve the staged
   package with 2FA.

Do not run `npm publish`, dispatch the publish workflow, create the public
release, or change repository visibility as part of a readiness check.

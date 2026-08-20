import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

describe("release readiness", () => {
  it("normalizes exactly one npm 11 or npm 12 pack result", async () => {
    const { normalizeNpmPackResult } =
      // @ts-expect-error The exercised release helper is intentionally executable ESM.
      await import("../scripts/npm-pack-result.mjs");
    const pack = {
      id: "lampwright@0.1.0",
      name: "lampwright",
      version: "0.1.0",
    };

    expect(normalizeNpmPackResult([pack], "lampwright")).toBe(pack);
    expect(normalizeNpmPackResult({ lampwright: pack }, "lampwright")).toBe(
      pack,
    );
    for (const invalid of [
      [],
      [pack, pack],
      [{ ...pack, name: "other" }],
      { lampwright: pack, other: pack },
      { other: pack },
      { lampwright: [pack] },
      null,
      "lampwright",
    ])
      expect(() => normalizeNpmPackResult(invalid, "lampwright")).toThrow(
        "npm pack returned an unexpected result",
      );
  });

  it("fails closed unless exact public tag publication authority is present", async () => {
    const command = join(repositoryRoot, "scripts", "verify-release.mjs");
    const authority = {
      ...process.env,
      GITHUB_REF_NAME: "v0.1.0",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REPOSITORY: "ukchucktown/lampwright",
      RELEASE_CONFIRMATION: "lampwright@0.1.0",
      REPOSITORY_PRIVATE: "false",
    };

    const exactAuthority = execFileAsync(process.execPath, [command], {
      env: authority,
    });
    if (supportsTrustedPublishingRuntime())
      await expect(exactAuthority).resolves.toMatchObject({
        stdout: expect.stringContaining(
          "Release authority verified for lampwright@0.1.0",
        ),
      });
    else
      await expect(exactAuthority).rejects.toMatchObject({
        stderr: expect.stringContaining("Node.js 22.14.0 or newer"),
      });
    await expect(
      execFileAsync(process.execPath, [command], {
        env: { ...authority, REPOSITORY_PRIVATE: "true" },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("visibility") });
    await expect(
      execFileAsync(process.execPath, [command], {
        env: { ...authority, GITHUB_REF_NAME: "main" },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Git tag") });
  });

  it("keeps candidate and publication workflows manual and pins every action", async () => {
    const workflows = await Promise.all(
      ["release-candidate.yml", "publish.yml"].map(async (name) => ({
        name,
        content: await readFile(
          join(repositoryRoot, ".github", "workflows", name),
          "utf8",
        ),
      })),
    );

    for (const workflow of workflows) {
      expect(workflow.content).toMatch(/^on:\n\s{2}workflow_dispatch:/mu);
      expect(workflow.content).not.toMatch(
        /^(?:\s{2})(?:push|pull_request|release|schedule):/mu,
      );
      const actionReferences = [
        ...workflow.content.matchAll(/uses:\s+\S+@(\S+)/gu),
      ];
      expect(actionReferences.length).toBeGreaterThan(0);
      for (const reference of actionReferences)
        expect(reference[1]).toMatch(/^[a-f\d]{40}$/u);
    }
    const publish = workflows.find(
      (workflow) => workflow.name === "publish.yml",
    )!.content;
    expect(publish).toContain("environment: npm-production");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("npm install --global npm@11.15.0");
    expect(publish).toContain("npm publish --provenance --access public");
    expect(publish).toContain("node scripts/verify-release.mjs");
  });

  it("contains no runtime network client or telemetry implementation", async () => {
    const source = (
      await Promise.all(
        (await sourceFiles(join(repositoryRoot, "src"))).map((path) =>
          readFile(path, "utf8"),
        ),
      )
    ).join("\n");

    expect(source).not.toMatch(
      /from\s+["']node:(?:http|https|http2|net|tls|dgram)["']/u,
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/\b(?:WebSocket|EventSource|XMLHttpRequest)\b/u);
    expect(source).toContain('DISABLE_TELEMETRY: "1"');
    expect(source).toContain('DO_NOT_TRACK: "1"');
  });

  it("uses platform-safe structured Docker commands for local Linux evidence", async () => {
    const helpers =
      // @ts-expect-error The exercised release helper is intentionally executable ESM.
      await import("../scripts/test-linux.mjs");
    const { copiedWorktreeFilter, linuxContainerCommands, runContainerSuite } =
      helpers;
    const commands = linuxContainerCommands(
      "24",
      join(repositoryRoot, "staged"),
      "container-id",
    );
    expect(commands).toEqual({
      create: [
        "create",
        "--workdir",
        "/app",
        "node:24",
        "node",
        "scripts/test-linux.mjs",
        "--container",
      ],
      copy: [
        "cp",
        `${join(repositoryRoot, "staged")}${process.platform === "win32" ? "\\" : "/"}.`,
        "container-id:/app",
      ],
      start: ["start", "--attach", "container-id"],
      remove: ["rm", "--force", "container-id"],
    });
    expect(Object.values(commands).flat()).not.toContain("bash");
    expect(Object.values(commands).flat()).not.toContain("-c");
    expect(copiedWorktreeFilter(repositoryRoot, repositoryRoot)).toBe(true);
    expect(
      copiedWorktreeFilter(
        repositoryRoot,
        join(repositoryRoot, "node_modules"),
      ),
    ).toBe(false);
    expect(
      copiedWorktreeFilter(repositoryRoot, join(repositoryRoot, "dist")),
    ).toBe(false);
    expect(
      copiedWorktreeFilter(repositoryRoot, join(repositoryRoot, ".git")),
    ).toBe(false);
    expect(
      copiedWorktreeFilter(repositoryRoot, join(repositoryRoot, "src")),
    ).toBe(true);
    const invocations: { executable: string; arguments: readonly string[] }[] =
      [];
    expect(
      runContainerSuite((executable: string, arguments_: readonly string[]) => {
        invocations.push({ executable, arguments: arguments_ });
        return { status: 0 };
      }),
    ).toBe(0);
    expect(invocations).toEqual([
      { executable: "npm", arguments: ["ci", "--silent"] },
      { executable: "npm", arguments: ["test"] },
    ]);
  });

  it("keeps the supported platform and Node matrix explicit", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "os: [ubuntu-latest, macos-latest, windows-latest]",
    );
    expect(workflow).toContain("node: [20.x, 22.x, 24.x]");
    expect(workflow).toContain("run: npm run pack:check");
    expect(workflow).not.toMatch(/\brun:\s+(?:bash|sh|pwsh|cmd)\b/u);
  });

  it("describes reversible availability in package metadata", async () => {
    const metadata = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly description: string };
    expect(metadata.description).toContain("reversibly disable");
    expect(metadata.description).toContain("enable");
  });

  it("keeps the packed first-release documentation complete", async () => {
    const [readme, security, specification, releaseNotes, verifier] =
      await Promise.all(
        [
          "README.md",
          "SECURITY.md",
          "docs/spec.md",
          "docs/releases/0.1.0.md",
          "scripts/verify-package.mjs",
        ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
      );

    expect(readme).toContain("npx lampwright@0.1.0");
    expect(readme).not.toContain("No npm version has been published yet");
    expect(security).toContain("`0.1.x`");
    expect(security).toContain("security/advisories/new");
    expect(specification).toContain("npx lampwright@0.1.0");
    expect(specification).not.toContain("Future published invocation");
    expect(verifier).toContain('"docs/releases/0.1.0.md"');
    for (const requiredTopic of [
      "Vercel `npx skills`",
      "Claude Code",
      "Codex",
      "Gemini CLI",
      "System Skills",
      "Git worktree",
      "Disabled Storage",
      "non-expiring",
      "Managed Removal",
      "Brute-force Removal",
      "Trash",
      "Restore",
      "Recovery expectations",
    ])
      expect(releaseNotes).toContain(requiredTopic);
  });

  it("keeps Availability operator terminology aligned with the CLI schema", async () => {
    const guide = await readFile(
      join(repositoryRoot, "docs", "availability.md"),
      "utf8",
    );
    const schema = JSON.parse(
      await readFile(
        join(repositoryRoot, "schemas", "cli-v1.schema.json"),
        "utf8",
      ),
    ) as {
      readonly $defs: {
        readonly confirmationEnvelope: {
          readonly properties: {
            readonly kind: { readonly const: string };
            readonly operation: { readonly enum: readonly string[] };
          };
        };
      };
    };
    expect(guide).toContain("`confirmation-required`");
    expect(guide).not.toContain("availability-confirmation");
    expect(schema.$defs.confirmationEnvelope.properties.kind.const).toBe(
      "confirmation-required",
    );
    expect(schema.$defs.confirmationEnvelope.properties.operation.enum).toEqual(
      expect.arrayContaining(["disable", "enable"]),
    );
  });
});

async function sourceFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(path);
  }
  return paths;
}

function supportsTrustedPublishingRuntime(): boolean {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((part) => Number(part));
  return major > 22 || (major === 22 && minor >= 14);
}

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

describe("release readiness", () => {
  it("fails closed unless exact public tag publication authority is present", async () => {
    const command = join(repositoryRoot, "scripts", "verify-release.mjs");
    const authority = {
      ...process.env,
      GITHUB_REF_NAME: "v0.1.0",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REPOSITORY: "ukchucktown/skill-cleaner",
      RELEASE_CONFIRMATION: "skill-cleaner@0.1.0",
      REPOSITORY_PRIVATE: "false",
    };

    const exactAuthority = execFileAsync(process.execPath, [command], {
      env: authority,
    });
    if (supportsTrustedPublishingRuntime())
      await expect(exactAuthority).resolves.toMatchObject({
        stdout: expect.stringContaining(
          "Release authority verified for skill-cleaner@0.1.0",
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

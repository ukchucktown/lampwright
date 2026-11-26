import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Release helpers are executable JavaScript outside the TypeScript build.
import { waitForPublishedVersion } from "../scripts/published-availability.mjs";

const name = "fixture-skill";
const version = "1.2.3";
const metadataUrl = "https://registry.npmjs.org/fixture-skill";
const tarballUrl = metadataUrl + "/-/fixture-skill-1.2.3.tgz";
const entry = { name, version, dist: { tarball: tarballUrl } };
function metadata(available: boolean) {
  return Response.json({
    name,
    "dist-tags": { latest: version },
    versions: available ? { [version]: entry } : {},
  });
}
function clock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: vi.fn(async (ms: number) => {
      elapsed += ms;
    }),
    log: vi.fn(),
  };
}

describe("public npm release availability", () => {
  it("waits for the exact install metadata and then its tarball, even if latest appears earlier", async () => {
    const time = clock();
    const responses = [
      new Response(null, { status: 404 }),
      metadata(false),
      metadata(true),
      new Response(null, { status: 404 }),
      metadata(true),
      new Response(null, { status: 200 }),
    ];
    const request = vi.fn<
      (url: string, options: RequestInit) => Promise<Response>
    >(async () => responses.shift()!);
    await waitForPublishedVersion(name, version, { ...time, request });
    expect(request.mock.calls.map(([url, init]) => [url, init.method])).toEqual(
      [
        [metadataUrl, "GET"],
        [metadataUrl, "GET"],
        [metadataUrl, "GET"],
        [tarballUrl, "HEAD"],
        [metadataUrl, "GET"],
        [tarballUrl, "HEAD"],
      ],
    );
    expect(request.mock.calls[0]![1].headers).toMatchObject({
      accept: "application/vnd.npm.install-v1+json",
    });
    expect(time.sleep).toHaveBeenCalledTimes(3);
  });

  it("checks an already available release immediately", async () => {
    const time = clock();
    const request = vi
      .fn()
      .mockResolvedValueOnce(metadata(true))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await waitForPublishedVersion(name, version, { ...time, request });
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it("retries a connection reset and preserves a permanent network error", async () => {
    const time = clock();
    const reset = new TypeError("fetch failed", {
      cause: { code: "ECONNRESET" },
    });
    const tls = new TypeError("invalid certificate", {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockRejectedValueOnce(tls);
    await expect(
      waitForPublishedVersion(name, version, { ...time, request }),
    ).rejects.toBe(tls);
    expect(time.sleep).toHaveBeenCalledTimes(1);
  });

  it("names the release and last registry failure when the deadline expires", async () => {
    const time = clock();
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      waitForPublishedVersion(name, version, { ...time, request }),
    ).rejects.toThrow(/fixture-skill@1\.2\.3.*503/);
    expect(time.now()).toBe(30 * 60_000);
  });

  it.each([
    [() => new Response(null, { status: 403 }), /403/],
    [() => Response.json({ name, versions: [] }), /metadata/],
    [
      () =>
        Response.json({
          name,
          versions: { [version]: { ...entry, version: "1.2.2" } },
        }),
      /metadata/,
    ],
    [
      () =>
        Response.json({
          name,
          versions: {
            [version]: {
              ...entry,
              dist: { tarball: "https://example.invalid/archive.tgz" },
            },
          },
        }),
      /tarball/,
    ],
  ] as const)(
    "fails on permanent registry errors without retrying",
    async (response, reason) => {
      const time = clock();
      const request = vi.fn(async () => response());
      await expect(
        waitForPublishedVersion(name, version, { ...time, request }),
      ).rejects.toThrow(reason);
      expect(time.sleep).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});

const createEnvironment = createIsolatedTestEnvironmentFixture();

describe("published CLI verification", () => {
  it.each([
    ["install", "fixture install failure", ["GET", "HEAD", "install"]],
    [
      "versionCheck",
      "Expected 1.2.3",
      ["GET", "HEAD", "install", "versionCheck"],
    ],
    [
      "helpCheck",
      "did not return help",
      ["GET", "HEAD", "install", "versionCheck", "helpCheck"],
    ],
  ] as const)(
    "preserves a %s failure after readiness without retrying any npm operation",
    async (fail, reason, expected) => {
      const env = await createEnvironment();
      const verifier = join(
        process.cwd(),
        "scripts",
        "verify-published-package.mjs",
      );
      const preload = join(env.workspace, "registry.mjs");
      const npmCli = join(env.workspace, "fixture-npm.cjs");
      const calls = join(env.workspace, "calls.log");
      await writeFile(
        join(env.workspace, "package.json"),
        JSON.stringify({ name, version }),
      );
      await writeFile(
        preload,
        `
      import {appendFileSync} from "node:fs";
      globalThis.fetch=async (_url,options)=>{
        appendFileSync(process.env.FIXTURE_CALLS,options.method+"\\n");
        return options.method==="HEAD" ? new Response(null,{status:200}) : Response.json(${JSON.stringify({ name, versions: { [version]: entry } })});
      };
    `,
      );
      await writeFile(
        npmCli,
        `
      const {appendFileSync}=require("node:fs");
      const command=process.argv[2]==="install" ? "install" : process.argv.at(-1);
      appendFileSync(process.env.FIXTURE_CALLS,command+"\\n");
      if(command==="install" && process.env.FIXTURE_FAIL==="install") {console.error("fixture install failure");process.exit(1);}
      if(command==="versionCheck") console.log(process.env.FIXTURE_FAIL==="versionCheck" ? "9.9.9" : ${JSON.stringify(version)});
      if(command==="helpCheck") console.log("unexpected help");
    `,
      );
      await expect(
        promisify(execFile)(
          process.execPath,
          ["--import", pathToFileURL(preload).href, verifier],
          {
            cwd: env.workspace,
            env: {
              ...env.environmentVariables,
              GITHUB_REF_TYPE: "tag",
              GITHUB_REF_NAME: `v${version}`,
              npm_execpath: npmCli,
              FIXTURE_CALLS: calls,
              FIXTURE_FAIL: fail,
            },
          },
        ),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(reason) });
      expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(
        expected,
      );
    },
  );
});

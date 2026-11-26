import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

const registry = "https://registry.npmjs.org";
const timeout = 30 * 60_000;
const pollInterval = 30_000;
const retryableStatuses = new Set([404, 408, 429, 500, 502, 503, 504]);
const retryableNetworkErrors = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

async function pendingStatus(response, resource) {
  if (response.status === 200) return null;
  await response.body?.cancel();
  const detail = `${resource} returned HTTP ${response.status}`;
  if (retryableStatuses.has(response.status)) return detail;
  throw new Error(detail);
}

async function checkAvailability(name, version, request, signal) {
  const options = { signal, redirect: "error" };
  const metadata = await request(`${registry}/${encodeURIComponent(name)}`, {
    ...options,
    method: "GET",
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  const pending = await pendingStatus(metadata, "package metadata");
  if (pending) return pending;
  const document = await metadata.json();
  const versions = document?.versions;
  if (
    document?.name !== name ||
    !versions ||
    typeof versions !== "object" ||
    Array.isArray(versions)
  )
    throw new Error(`Invalid install metadata for ${name}@${version}.`);
  if (!Object.hasOwn(versions, version))
    return "version absent from install metadata";
  const entry = versions[version];
  if (
    entry?.name !== name ||
    entry.version !== version ||
    typeof entry.dist?.tarball !== "string"
  )
    throw new Error(`Invalid install metadata for ${name}@${version}.`);
  const tarball = new URL(entry.dist.tarball);
  if (tarball.origin !== registry || tarball.username || tarball.password)
    throw new Error(
      `Unexpected public registry tarball URL for ${name}@${version}.`,
    );
  const archive = await request(tarball.href, { ...options, method: "HEAD" });
  return pendingStatus(archive, "tarball");
}

export async function waitForPublishedVersion(
  name,
  version,
  {
    request = globalThis.fetch,
    now = () => performance.now(),
    sleep = delay,
    log = (message) => process.stdout.write(message + "\n"),
  } = {},
) {
  const spec = `${name}@${version}`;
  const deadline = now() + timeout;
  let lastReason = "deadline reached";
  while (now() < deadline) {
    const signal = globalThis.AbortSignal.timeout(
      Math.max(1, Math.min(10_000, Math.ceil(deadline - now()))),
    );
    try {
      const reason = await checkAvailability(name, version, request, signal);
      if (reason === null && now() <= deadline) return;
      lastReason = reason ?? "registry response arrived after the deadline";
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      const timedOut =
        signal.aborted &&
        (error === signal.reason || error?.name === "AbortError");
      if (!timedOut && !retryableNetworkErrors.has(code)) throw error;
      lastReason = timedOut ? "registry request timed out" : code;
    }
    const wait = Math.min(pollInterval, deadline - now());
    if (wait > 0) {
      log(
        `Waiting for ${spec} (${lastReason}). Next check in ${Math.ceil(wait / 1000)}s.`,
      );
      await sleep(wait);
    }
  }
  throw new Error(
    `Timed out after ${timeout / 60_000} minutes waiting for ${spec} on the public registry (${lastReason}).`,
  );
}

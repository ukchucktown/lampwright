/* global fetch */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return JSON.parse(trimmed);
  return trimmed;
}

export function parseRepositoryConfig(markdown) {
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SDLC configuration needs YAML frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("SDLC configuration frontmatter is incomplete");
  const config = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`invalid SDLC configuration line '${line}'`);
    config[line.slice(0, separator).trim()] = scalar(line.slice(separator + 1));
  }
  if (config.schemaVersion !== 1) throw new Error("unsupported SDLC configuration schema");
  return config;
}

export async function readRepositoryConfig(file) {
  return parseRepositoryConfig(await readFile(file, "utf8"));
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

export function branchMatch(pattern, branch) {
  const expression = pattern
    .split(/(\{issue\}|\{slug\})/g)
    .map((part) => {
      if (part === "{issue}") return "(?<issue>[1-9][0-9]*)";
      if (part === "{slug}") return "(?<slug>[^/]+)";
      return escapeRegularExpression(part);
    })
    .join("");
  return branch.match(new RegExp(`^${expression}$`));
}

export function classifyPullRequest(pullRequest, config) {
  const finalMatch = branchMatch(config.integrationBranchPattern, pullRequest.head.ref);
  if (pullRequest.base.ref === config.stableBranch && finalMatch) {
    return { type: "feature", featureNumber: Number(finalMatch.groups.issue) };
  }
  const childMatch = branchMatch(config.integrationBranchPattern, pullRequest.base.ref);
  if (childMatch) {
    return { type: "child", featureNumber: Number(childMatch.groups.issue) };
  }
  return { type: "ordinary" };
}

export function closingIssue(body) {
  const matches = [...String(body ?? "").matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9][0-9]*)\b/gi,
  )];
  if (matches.length !== 1) {
    throw new Error("the pull request body must close exactly one issue");
  }
  return Number(matches[0][1]);
}

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
}

function assertLabel(issue, label, role) {
  if (!labelNames(issue).includes(label)) {
    throw new Error(`issue #${issue.number} is not labeled as an SDLC ${role}`);
  }
}

export async function validatePullRequest({ event, config, api }) {
  const classification = classifyPullRequest(event.pull_request, config);
  if (classification.type === "ordinary") {
    return { profile: "none", classification };
  }

  const referencedIssue = closingIssue(event.pull_request.body);
  if (classification.type === "child") {
    const issue = await api.issue(referencedIssue);
    assertLabel(issue, config.childLabel, "child");
    if (issue.state !== "open" && event.action !== "closed") {
      throw new Error(`child issue #${issue.number} is not open`);
    }
    const parent = await api.parent(issue.number);
    if (parent.number !== classification.featureNumber) {
      throw new Error(
        `child issue #${issue.number} belongs to #${parent.number}, not #${classification.featureNumber}`,
      );
    }
    const feature = await api.issue(parent.number);
    assertLabel(feature, config.featureLabel, "feature");
    if (feature.state !== "open") {
      throw new Error(`feature issue #${feature.number} is not open`);
    }
    const blockers = await api.blockedBy(issue.number);
    const open = blockers.filter((blocker) => blocker.state !== "closed");
    if (open.length > 0) {
      throw new Error(
        `child issue #${issue.number} has open blockers: ${open.map((blocker) => `#${blocker.number}`).join(", ")}`,
      );
    }
    return {
      profile: "child",
      classification,
      issue: issue.number,
    };
  }

  if (referencedIssue !== classification.featureNumber) {
    throw new Error(
      `the final pull request must close parent issue #${classification.featureNumber}`,
    );
  }
  const parent = await api.issue(referencedIssue);
  assertLabel(parent, config.featureLabel, "feature");
  if (parent.state !== "open") throw new Error(`feature issue #${parent.number} is not open`);
  const children = await api.subIssues(parent.number);
  if (children.length === 0) throw new Error(`feature issue #${parent.number} has no child issues`);
  for (const child of children) {
    assertLabel(child, config.childLabel, "child");
  }
  const incomplete = children.filter((child) => child.state !== "closed");
  if (incomplete.length > 0) {
    throw new Error(
      `feature issue #${parent.number} has incomplete children: ${incomplete.map((child) => `#${child.number}`).join(", ")}`,
    );
  }
  return {
    profile: "feature",
    classification,
    issue: parent.number,
  };
}

export function runValidationCommands({ config, profile, repositoryRoot, runner = execFileSync }) {
  if (profile === "none") return [];
  const key = profile === "child" ? "childValidationCommands" : "featureValidationCommands";
  const commands = config[key] ?? [];
  for (const command of commands) {
    if (!command || typeof command.executable !== "string" || !Array.isArray(command.args) ||
        command.args.some((argument) => typeof argument !== "string")) {
      throw new Error(`invalid structured command in '${key}'`);
    }
    runner(command.executable, command.args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      shell: false,
    });
  }
  return commands;
}

export async function closeMergedChild({ event, config, api }) {
  if (!event.pull_request.merged) return { affected: false, reason: "not-merged" };
  if (!config.closeChildOnIntegrationMerge) {
    return { affected: false, reason: "automatic-close-disabled" };
  }
  const classification = classifyPullRequest(event.pull_request, config);
  if (classification.type !== "child") return { affected: false, reason: "ordinary-or-feature" };
  const validation = await validatePullRequest({ event, config, api });
  await api.closeIssue(validation.issue);
  return { affected: true, issue: validation.issue };
}

export class GitHubApi {
  constructor(repository, token, fetchImplementation = fetch) {
    this.repository = repository;
    this.token = token;
    this.fetch = fetchImplementation;
  }

  async request(endpoint, options = {}) {
    const response = await this.fetch(
      `https://api.github.com/repos/${this.repository}${endpoint}`,
      {
        ...options,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          ...(options.headers ?? {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} for ${endpoint}: ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  }

  issue(number) {
    return this.request(`/issues/${number}`);
  }

  parent(number) {
    return this.request(`/issues/${number}/parent`);
  }

  blockedBy(number) {
    return this.request(`/issues/${number}/dependencies/blocked_by?per_page=100`);
  }

  subIssues(number) {
    return this.request(`/issues/${number}/sub_issues?per_page=100`);
  }

  closeIssue(number) {
    return this.request(`/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
      headers: { "Content-Type": "application/json" },
    });
  }
}

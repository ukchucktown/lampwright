#!/usr/bin/env node
/* global console, process */

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  GitHubApi,
  readRepositoryConfig,
  runValidationCommands,
  validatePullRequest,
} from "./sdlc-contract-lib.mjs";

function optionsFor(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    options[rest[index].replace(/^--/, "")] = rest[index + 1];
  }
  return { command, options };
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required`);
  return options[key];
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else process.stdout.write(`${name}=${value}\n`);
}

async function main() {
  const { command, options } = optionsFor(process.argv.slice(2));
  const config = await readRepositoryConfig(required(options, "config"));
  if (command === "validate") {
    const event = JSON.parse(await readFile(required(options, "event"), "utf8"));
    const api = new GitHubApi(event.repository.full_name, process.env.GITHUB_TOKEN);
    const result = await validatePullRequest({ event, config, api });
    output("profile", result.profile);
    if (result.issue) output("issue", result.issue);
    return;
  }
  if (command === "run-validation") {
    runValidationCommands({
      config,
      profile: required(options, "profile"),
      repositoryRoot: required(options, "repository-root"),
    });
    return;
  }
  throw new Error(`unknown command '${command}'`);
}

main().catch((error) => {
  console.error(`SDLC contract failed: ${error.message}`);
  process.exitCode = 1;
});

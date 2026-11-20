#!/usr/bin/env node
/* global console, process */

import { readFile } from "node:fs/promises";

import {
  closeMergedChild,
  GitHubApi,
  readRepositoryConfig,
} from "./sdlc-contract-lib.mjs";

function optionsFor(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    options[values[index].replace(/^--/, "")] = values[index + 1];
  }
  return options;
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required`);
  return options[key];
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  const event = JSON.parse(await readFile(required(options, "event"), "utf8"));
  const config = await readRepositoryConfig(required(options, "config"));
  const api = new GitHubApi(event.repository.full_name, process.env.GITHUB_TOKEN);
  const result = await closeMergedChild({ event, config, api });
  if (result.affected) console.log(`Closed child issue #${result.issue}.`);
  else console.log(`No child issue changed: ${result.reason}.`);
}

main().catch((error) => {
  console.error(`SDLC child close failed: ${error.message}`);
  process.exitCode = 1;
});

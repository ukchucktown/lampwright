import { afterEach } from "vitest";

import {
  createIsolatedTestEnvironment,
  type IsolatedTestEnvironment,
} from "./isolated-test-environment.js";

export function createIsolatedTestEnvironmentFixture(): () => Promise<IsolatedTestEnvironment> {
  const environments: IsolatedTestEnvironment[] = [];

  afterEach(async () => {
    await Promise.all(
      environments.splice(0).map((environment) => environment.dispose()),
    );
  });

  return async () => {
    const environment = await createIsolatedTestEnvironment();
    environments.push(environment);
    return environment;
  };
}

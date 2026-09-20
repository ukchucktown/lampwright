import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { sessionSetupJsonSchema } from "../dist/session-setup/validation.js";

writeFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../schemas/session-setup-v1.schema.json",
  ),
  await format(JSON.stringify(sessionSetupJsonSchema()), { parser: "json" }),
);

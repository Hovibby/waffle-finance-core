/**
 * Vitest configuration for the health-check E2E test suite.
 *
 * Resolves workspace packages to TypeScript source so no separate build
 * step is required.  Uses forks pool so each test file gets a clean process
 * environment (important for env-var manipulation in health tests).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      {
        find: /^@wafflefinance\/config\/node$/,
        replacement: path.join(root, "packages/config/src/node.ts"),
      },
      {
        find: /^@wafflefinance\/config$/,
        replacement: path.join(root, "packages/config/src/index.ts"),
      },
      {
        find: /^@wafflefinance\/sdk\/secrets$/,
        replacement: path.join(root, "packages/sdk/src/secrets/index.ts"),
      },
      {
        find: /^@wafflefinance\/sdk$/,
        replacement: path.join(root, "packages/sdk/src/index.ts"),
      },
    ],
  },
});

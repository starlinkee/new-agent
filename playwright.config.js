import { createHash } from "node:crypto";
import { defineConfig } from "@playwright/test";

// Several tickets run in parallel on one machine, each in its own workspace.
// Derive a stable port from the workspace path so they never collide.
const hash = createHash("sha1").update(process.cwd()).digest().readUInt16BE(0);
const port = Number(process.env.PORT || 3000 + (hash % 5000));

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  retries: 0,
  use: { baseURL: `http://localhost:${port}`, headless: true },
  webServer: {
    command: "node src/server.js",
    env: { PORT: String(port) },
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});

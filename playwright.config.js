import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { defineConfig } from "@playwright/test";

// Several tickets run in parallel on one machine, each in its own workspace.
// Derive a stable port from the workspace path so they never collide.
const hash = createHash("sha1").update(process.cwd()).digest().readUInt16BE(0);
const port = Number(process.env.PORT || 3000 + (hash % 5000));

// Chromium needs libnss3/libnspr4/libasound2. On this WSL they are extracted without root
// (docs/WSL_SETUP.md); pass them to the browser explicitly, since the environment variable
// does not always reach the browser process when agents run the tests.
const libs = `${os.homedir()}/.local/playwright-libs/usr/lib/x86_64-linux-gnu`;
const browserEnv = fs.existsSync(libs)
  ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
  : undefined;

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  retries: 0,
  use: { baseURL: `http://localhost:${port}`, headless: true, launchOptions: { env: browserEnv } },
  webServer: {
    command: "node src/server.js",
    env: { PORT: String(port) },
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});

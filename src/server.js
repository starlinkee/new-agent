import http from "node:http";
import { handleTodos } from "./todos.js";
import { renderTodosPage } from "./todos-page.js";
import { renderWorldPage } from "./world-page.js";
import { renderPixelsPage } from "./pixels-page.js";
import { renderPollsPage } from "./polls-page.js";
import { renderBlobsPage } from "./blobs-page.js";
import { renderPulsePage } from "./pulse-page.js";
import { renderBiomePage } from "./biome-page.js";
import { handleVendor } from "./vendor.js";
import { layout } from "./layout.js";
import { handleRequest } from "./site.js";
import { handleHealth } from "./health.js";
import { handleSnapshots } from "./world-snapshots.js";
import { handlePixels } from "./pixels.js";
import { handlePixelStream } from "./pixels-stream.js";
import { handlePixelsHistory } from "./pixels-history.js";
import { handlePolls } from "./polls.js";
import { handlePollStream } from "./polls-stream.js";
import { handlePollActivity } from "./polls-activity.js";
import { handlePulse } from "./pulse.js";
import { handlePulseLive } from "./pulse-live.js";
import { handleBlobs } from "./blobs.js";
import { handleBlobStream } from "./blobs-stream.js";
import { handleBlobScores } from "./blobs-scores.js";
import { handleBiome } from "./biome.js";
import { handleBiomeStream } from "./biome-stream.js";
import { startDefaultBots } from "./blobs-bots.js";

export function renderPage() {
  return layout({
    title: "Hello",
    body: `<h1 id="greeting">Hello, world!</h1><p><a id="todos-link" href="/todos">Todos</a></p>`,
  });
}

const port = Number(process.env.PORT || 3000);
startDefaultBots();

http
  .createServer(async (req, res) => {
    try {
      if (new URL(req.url, "http://localhost").pathname === "/health") return handleHealth(req, res);
      if (await handleTodos(req, res)) return;
      if (await handleSnapshots(req, res)) return;
      if (await handlePixelStream(req, res)) return;
      if (await handlePixelsHistory(req, res)) return;
      if (await handlePixels(req, res)) return;
      if (await handlePollStream(req, res)) return;
      if (await handlePollActivity(req, res)) return;
      if (await handlePolls(req, res)) return;
      if (await handleBlobStream(req, res)) return;
      if (await handleBlobScores(req, res)) return;
      if (await handleBlobs(req, res)) return;
      if (await handlePulseLive(req, res)) return;
      if (await handlePulse(req, res)) return;
      if (await handleBiomeStream(req, res)) return;
      if (await handleBiome(req, res)) return;
      if (await handleVendor(req, res)) return;
      await handleRequest(req, res, { "/": renderPage, "/todos": renderTodosPage, "/world": renderWorldPage, "/pixels": renderPixelsPage, "/polls": renderPollsPage, "/blobs": renderBlobsPage, "/pulse": renderPulsePage, "/biome": renderBiomePage });
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`));

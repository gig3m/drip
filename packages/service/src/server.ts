import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";

const config = loadConfig();
const store = new Store(config.dataDir);
const app = createApp(store, config);

const sweeper = setInterval(() => {
  const n = store.sweep();
  if (n > 0) console.log(`drip: swept ${n} expired file(s)`);
}, config.sweepIntervalMs);
sweeper.unref();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`drip listening on :${info.port} (base ${config.baseUrl})`);
});

// Local development server.
import { serve } from "@hono/node-server";

import { app } from "./app";
import { env } from "./env";

serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Threads Story Studio API on http://localhost:${info.port}`);
});

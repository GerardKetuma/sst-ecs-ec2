import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();
app.get("/", (c) => c.text("hello from the multi-service api"));
app.get("/healthz", (c) => c.text("ok"));
serve({ fetch: app.fetch, port: 3000 });
console.log("api listening on :3000");

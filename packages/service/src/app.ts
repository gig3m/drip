import { Hono, type Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, FileMeta } from "./store.js";
import type { Config } from "./config.js";
import { parseDuration } from "./config.js";
import { sanitizeFilename } from "./util.js";
import type { UploadResult } from "@drip/shared";

export function createApp(store: Store, config: Config): Hono {
  const app = new Hono();

  const toResult = (m: FileMeta): UploadResult => ({
    id: m.id,
    url: new URL(`/f/${m.id}/${encodeURIComponent(m.filename)}`, config.baseUrl).toString(),
    filename: m.filename,
    size: m.size,
    content_type: m.content_type,
    expires_at: new Date(m.expires_at).toISOString(),
  });

  const digest = (v: string) => createHash("sha256").update(v).digest();
  const requireToken = (header: string | undefined): boolean =>
    !config.token || timingSafeEqual(digest(header ?? ""), digest(`Bearer ${config.token}`));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/upload", async (c) => {
    if (!requireToken(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);

    const declaredLen = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declaredLen) && declaredLen > config.maxSizeBytes) {
      return c.json({ error: "too large" }, 413);
    }

    let ttlMs = config.defaultTtlMs;
    const ttlParam = c.req.query("ttl");
    if (ttlParam) {
      try { ttlMs = Math.min(parseDuration(ttlParam), config.maxTtlMs); }
      catch { return c.json({ error: "invalid ttl" }, 400); }
    }

    const results: UploadResult[] = [];
    const ct = c.req.header("content-type") ?? "";

    const storeOne = (bytes: Uint8Array, name: string, type: string) =>
      results.push(toResult(store.put(bytes, sanitizeFilename(name), type || "application/octet-stream", ttlMs)));

    if (ct.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const files = form.getAll("file").filter((f): f is File => f instanceof File);
      if (files.length === 0) return c.json({ error: "no file field" }, 400);
      for (const f of files) if (f.size > config.maxSizeBytes) return c.json({ error: "too large" }, 413);
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        storeOne(bytes, f.name || "file", f.type || "application/octet-stream");
      }
    } else {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) return c.json({ error: "empty body" }, 400);
      if (bytes.byteLength > config.maxSizeBytes) return c.json({ error: "too large" }, 413);
      const name = c.req.query("name") || "upload";
      storeOne(bytes, name, ct);
    }

    return c.json(results.length === 1 ? results[0] : { items: results });
  });

  const serveFile = (c: Context) => {
    const found = store.get(c.req.param("id") ?? "");
    if (!found) return c.json({ error: "not found" }, 404);
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        "content-type": found.meta.content_type,
        "content-disposition": `inline; filename="${found.meta.filename}"`,
        "content-length": String(found.meta.size),
        "x-content-type-options": "nosniff",
        // Uploads carry a client-chosen content-type; an uploaded HTML/SVG must not run script on this origin.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  };

  app.get("/files", (c) => {
    const limit = Number(c.req.query("limit"));
    const items = store.list(Number.isFinite(limit) ? limit : 20).map((m) => ({
      ...toResult(m),
      created_at: new Date(m.created_at).toISOString(),
    }));
    return c.json(items);
  });

  app.get("/f/:id/:name", serveFile);
  app.get("/f/:id", serveFile);

  app.delete("/f/:id", (c) => {
    if (!requireToken(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    return store.delete(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  const publicDir = config.publicDir ?? "public";
  // The landing page and scripts name this server's own URL; fill it in from DRIP_BASE_URL.
  const origin = config.baseUrl.replace(/\/+$/, "");
  const templated = (file: string, type: string) => (c: Context) => {
    let body: string;
    try { body = readFileSync(join(publicDir, file), "utf8"); } catch { return c.notFound(); }
    return c.body(body.replaceAll("__DRIP_BASE_URL__", origin), 200, { "content-type": type });
  };
  app.get("/", templated("index.html", "text/html; charset=utf-8"));
  app.get("/install.sh", templated("install.sh", "text/x-shellscript; charset=utf-8"));
  app.get("/raycast/send-to-drip.sh", templated("raycast/send-to-drip.sh", "text/x-shellscript; charset=utf-8"));
  app.get("/dl/*", serveStatic({ root: publicDir }));

  return app;
}

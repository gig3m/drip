import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";

let dir: string;
let now: number;
let store: Store;

const cfg = (over: Partial<Config> = {}): Config => ({
  baseUrl: "https://h", dataDir: dir, defaultTtlMs: 1000, maxTtlMs: 10_000,
  maxSizeBytes: 10, sweepIntervalMs: 1000, port: 8787, ...over,
});

function multipart(files: { name: string; type: string; bytes: number[] }[]): FormData {
  const f = new FormData();
  for (const x of files) f.append("file", new Blob([new Uint8Array(x.bytes)], { type: x.type }), x.name);
  return f;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "drip-")); now = 1_000_000; store = new Store(dir, () => now); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("app", () => {
  it("GET /healthz", async () => {
    const res = await createApp(store, cfg()).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /upload (single) returns a UploadResult with a built URL", async () => {
    const res = await createApp(store, cfg()).request("/upload", { method: "POST", body: multipart([{ name: "x.png", type: "image/png", bytes: [1, 2, 3] }]) });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.filename).toBe("x.png");
    expect(j.size).toBe(3);
    expect(j.content_type).toBe("image/png");
    expect(j.url).toBe(`https://h/f/${j.id}/x.png`);
    expect(j.expires_at).toBe(new Date(1_001_000).toISOString());
  });

  it("POST /upload (multi) returns items[]", async () => {
    const res = await createApp(store, cfg()).request("/upload", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }, { name: "b", type: "text/plain", bytes: [2] }]) });
    const j = await res.json();
    expect(j.items).toHaveLength(2);
  });

  it("round-trips bytes through GET /f/:id/:name with content-type", async () => {
    const app = createApp(store, cfg());
    const up = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "x.png", type: "image/png", bytes: [5, 6, 7] }]) })).json();
    const res = await app.request(`/f/${up.id}/x.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([5, 6, 7]));
  });

  it("413 when a file exceeds maxSizeBytes", async () => {
    const res = await createApp(store, cfg({ maxSizeBytes: 2 })).request("/upload", { method: "POST", body: multipart([{ name: "big", type: "text/plain", bytes: [1, 2, 3] }]) });
    expect(res.status).toBe(413);
  });

  it("400 when no file field is present", async () => {
    const res = await createApp(store, cfg()).request("/upload", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });

  it("404 for unknown or expired id", async () => {
    const app = createApp(store, cfg());
    expect((await app.request("/f/missing/x")).status).toBe(404);
    const up = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) })).json();
    now = 1_001_000;
    expect((await app.request(`/f/${up.id}/a`)).status).toBe(404);
  });

  it("clamps ttl above max instead of rejecting", async () => {
    const res = await createApp(store, cfg({ maxTtlMs: 5000 })).request("/upload?ttl=1h", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) });
    const j = await res.json();
    expect(j.expires_at).toBe(new Date(1_000_000 + 5000).toISOString());
  });

  it("token: 401 without header, 200 with correct bearer", async () => {
    const app = createApp(store, cfg({ token: "sekret" }));
    expect((await app.request("/upload", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) })).status).toBe(401);
    const ok = await app.request("/upload", { method: "POST", headers: { authorization: "Bearer sekret" }, body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) });
    expect(ok.status).toBe(200);
  });

  it("sanitizes traversal in filenames", async () => {
    const res = await createApp(store, cfg()).request("/upload", { method: "POST", body: multipart([{ name: "../../etc/passwd", type: "text/plain", bytes: [1] }]) });
    const j = await res.json();
    expect(j.filename).not.toContain("/");
    expect(j.filename).not.toContain("..");
  });

  it("DELETE success: upload then delete then 404 on subsequent GET", async () => {
    const app = createApp(store, cfg());
    const up = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) })).json();
    const del = await app.request(`/f/${up.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await app.request(`/f/${up.id}/a`)).status).toBe(404);
  });

  it("DELETE unknown id returns 404", async () => {
    const app = createApp(store, cfg());
    expect((await app.request("/f/missing", { method: "DELETE" })).status).toBe(404);
  });

  it("DELETE token gate: 401 without auth, not 401 with correct bearer", async () => {
    const app = createApp(store, cfg({ token: "sekret" }));
    expect((await app.request("/f/anything", { method: "DELETE" })).status).toBe(401);
    const withAuth = await app.request("/f/anything", { method: "DELETE", headers: { authorization: "Bearer sekret" } });
    expect(withAuth.status).not.toBe(401);
  });

  it("invalid ttl returns 400", async () => {
    const res = await createApp(store, cfg()).request("/upload?ttl=garbage", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) });
    expect(res.status).toBe(400);
  });

  it("413 from an oversized content-length header, before the body is buffered", async () => {
    const app = createApp(store, cfg({ maxSizeBytes: 2 }));
    const res = await app.request("/upload?name=x", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "999999" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(413);
    const entries = readdirSync(dir);
    for (const entry of entries) expect(entry.startsWith("drip.db")).toBe(true);
  });

  it("multi-file 413 leaves no orphan file on disk", async () => {
    const res = await createApp(store, cfg({ maxSizeBytes: 2 })).request("/upload", {
      method: "POST",
      body: multipart([{ name: "small", type: "text/plain", bytes: [1] }, { name: "big", type: "text/plain", bytes: [1, 2, 3] }]),
    });
    expect(res.status).toBe(413);
    const entries = readdirSync(dir);
    for (const entry of entries) expect(entry.startsWith("drip.db")).toBe(true);
  });

  it("GET /files lists uploads newest-first with created_at", async () => {
    const app = createApp(store, cfg());
    const u1 = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "a.txt", type: "text/plain", bytes: [1] }]) })).json();
    now += 10;
    const u2 = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "b.txt", type: "text/plain", bytes: [2] }]) })).json();
    const res = await app.request("/files");
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.map((x: any) => x.id)).toEqual([u2.id, u1.id]);
    expect(list[0].url).toBe(`https://h/f/${u2.id}/b.txt`);
    expect(typeof list[0].created_at).toBe("string");
    expect(list[0].filename).toBe("b.txt");
  });

  it("GET /files clamps limit and never errors on garbage", async () => {
    const app = createApp(store, cfg());
    await app.request("/upload", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) });
    expect((await app.request("/files?limit=abc")).status).toBe(200);
    expect((await app.request("/files?limit=99999")).status).toBe(200);
  });

  it("GET /f/:id (no name) serves bytes and 404s like the named route", async () => {
    const app = createApp(store, cfg());
    const up = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "x.png", type: "image/png", bytes: [9, 8, 7] }]) })).json();
    const res = await app.request(`/f/${up.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect((await app.request("/f/missing")).status).toBe(404);
  });

  it("serves landing page, installer, and downloads from publicDir", async () => {
    const pub = mkdtempSync(join(tmpdir(), "drip-pub-"));
    mkdirSync(join(pub, "dl"), { recursive: true });
    mkdirSync(join(pub, "raycast"), { recursive: true });
    writeFileSync(join(pub, "index.html"), "<!doctype html><title>drip</title>hello");
    writeFileSync(join(pub, "install.sh"), "#!/bin/sh\necho hi\nBASE=__DRIP_BASE_URL__\n");
    writeFileSync(join(pub, "dl", "drip-linux-x64"), "BINARY");
    writeFileSync(join(pub, "dl", "SHA256SUMS"), "abc  drip-linux-x64\n");
    writeFileSync(join(pub, "raycast", "send-to-drip.sh"), "# @raycast.title Send to drip\n");

    const app = createApp(store, cfg({ publicDir: pub }));
    const idx = await app.request("/");
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("drip");

    const sh = await app.request("/install.sh");
    expect(sh.status).toBe(200);
    const shText = await sh.text();
    expect(shText).toContain("echo hi");
    expect(shText).toContain("BASE=https://h\n");

    const bin = await app.request("/dl/drip-linux-x64");
    expect(bin.status).toBe(200);
    expect(await bin.text()).toBe("BINARY");

    expect((await app.request("/dl/SHA256SUMS")).status).toBe(200);

    const ray = await app.request("/raycast/send-to-drip.sh");
    expect(ray.status).toBe(200);
    expect(await ray.text()).toContain("Send to drip");

    rmSync(pub, { recursive: true, force: true });
  });

  it("does not serve files outside publicDir/dl via traversal", async () => {
    const pub = mkdtempSync(join(tmpdir(), "drip-pub2-"));
    mkdirSync(join(pub, "dl"), { recursive: true });
    writeFileSync(join(pub, "secret.txt"), "SECRET");
    const app = createApp(store, cfg({ publicDir: pub }));
    const res = await app.request("/dl/..%2fsecret.txt");
    expect(res.status).not.toBe(200);
    rmSync(pub, { recursive: true, force: true });
  });

  it("raw-body upload (non-multipart) stores and round-trips bytes", async () => {
    const app = createApp(store, cfg());
    const res = await app.request("/upload?name=x.png", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.content_type).toBe("image/png");
    expect(j.filename).toBe("x.png");
    const got = await app.request(`/f/${j.id}/${j.filename}`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("DELETE with a non-id path segment cannot unlink files in the data dir", async () => {
    const app = createApp(store, cfg());
    for (const id of ["drip.db", "drip.db-wal", "..%2Fx"]) {
      expect((await app.request(`/f/${id}`, { method: "DELETE" })).status).toBe(404);
    }
    expect(readdirSync(dir)).toContain("drip.db");
    const up = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "a", type: "text/plain", bytes: [1] }]) })).json();
    expect((await app.request(`/f/${up.id}`)).status).toBe(200);
  });

  it("serves uploads under a sandboxing CSP so uploaded HTML/SVG cannot script the origin", async () => {
    const app = createApp(store, cfg());
    const up = await (await app.request("/upload", { method: "POST", body: multipart([{ name: "x.html", type: "text/html", bytes: [60, 98, 62] }]) })).json();
    const res = await app.request(`/f/${up.id}/x.html`);
    expect(res.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
  });
});

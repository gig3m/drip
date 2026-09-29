import { describe, it, expect, vi, afterEach } from "vitest";
import { DripClient, DripError, filenameFromDisposition } from "./client.js";

const OK: any = { id: "abc", url: "https://h/f/abc/x.png", filename: "x.png", size: 3, content_type: "image/png", expires_at: "2026-01-01T00:00:00.000Z" };

afterEach(() => vi.restoreAllMocks());

describe("DripClient", () => {

  it("delete sends DELETE to /f/:id with the bearer header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new DripClient({ baseUrl: "https://h", token: "t0k" }).delete("a b");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://h/f/a%20b");
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer t0k");
  });

  it("delete throws DripError carrying the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(new DripClient({ baseUrl: "https://h" }).delete("x")).rejects.toMatchObject({ status: 404 });
  });
  it("uploadBytes posts multipart and returns the single result", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new DripClient({ baseUrl: "https://h" });
    const r = await c.uploadBytes(new Uint8Array([1, 2, 3]), "x.png", "image/png");
    expect(r.id).toBe("abc");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://h/upload");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("adds ttl query and bearer header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new DripClient({ baseUrl: "https://h", token: "t0k" });
    await c.uploadBytes(new Uint8Array([1]), "x.png", "image/png", { ttl: "1h" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://h/upload?ttl=1h");
    expect(init.headers.authorization).toBe("Bearer t0k");
  });

  it("unwraps items[] for multi-file uploads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [OK, OK] }), { status: 200 })));
    const c = new DripClient({ baseUrl: "https://h" });
    const rs = await c.uploadFiles([{ bytes: new Uint8Array([1]), filename: "a", contentType: "text/plain" }]);
    expect(rs).toHaveLength(2);
  });

  it("throws DripError with status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 413 })));
    const c = new DripClient({ baseUrl: "https://h" });
    await expect(c.uploadBytes(new Uint8Array([1]), "x", "text/plain")).rejects.toMatchObject({ status: 413 });
  });
});

describe("filenameFromDisposition", () => {
  it("parses quoted and bare filenames, tolerates null", () => {
    expect(filenameFromDisposition(`inline; filename="a b.png"`)).toBe("a b.png");
    expect(filenameFromDisposition(`attachment; filename=c.txt`)).toBe("c.txt");
    expect(filenameFromDisposition(null)).toBeUndefined();
  });
});

describe("DripClient.list", () => {
  it("GETs /files with a limit and returns the array", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "1" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new DripClient({ baseUrl: "https://h" });
    const out = await c.list(5);
    expect(out).toEqual([{ id: "1" }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://h/files?limit=5");
  });

  it("throws DripError on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    const c = new DripClient({ baseUrl: "https://h" });
    await expect(c.list()).rejects.toBeInstanceOf(DripError);
  });
});

describe("DripClient.get", () => {
  it("resolves a bare id to /f/:id and reads filename + type from headers", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-disposition": `inline; filename="pic.png"` },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new DripClient({ baseUrl: "https://h" });
    const r = await c.get("abc123");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://h/f/abc123");
    expect(r.filename).toBe("pic.png");
    expect(r.contentType).toBe("image/png");
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
  });

  it("passes a full URL through unchanged and throws DripError on 404", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new DripClient({ baseUrl: "https://h" });
    await expect(c.get("https://h/f/xyz/name.png")).rejects.toMatchObject({ status: 404 });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://h/f/xyz/name.png");
  });
});

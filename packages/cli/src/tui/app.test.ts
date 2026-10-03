import { describe, it, expect, vi } from "vitest";
import { DripError, type FileListItem } from "@drip/shared";
import type { Key, Terminal } from "./term.js";
import { initialState, withItems, type State } from "./state.js";
import { contentKind, expandHome, runEffect, runTui, LIST_LIMIT, type AppDeps } from "./app.js";

const item = (id: string, filename: string, content_type = "image/png"): FileListItem => ({
  id, filename, content_type, url: `https://h/f/${id}/${filename}`, size: 4,
  created_at: "2026-09-22T00:00:00.000Z", expires_at: "2026-09-23T00:00:00.000Z",
});
const BYTES = new Uint8Array([104, 105]); // "hi"

function deps(over: Partial<AppDeps> = {}, client: Partial<AppDeps["client"]> = {}): AppDeps {
  return {
    client: {
      list: vi.fn(async () => [item("a", "a.png")]),
      get: vi.fn(async () => ({ bytes: BYTES, filename: "x", contentType: "image/png; q=1" })),
      delete: vi.fn(async () => {}),
      setTtl: vi.fn(async (id: string) => ({ ...item(id, `${id}.png`), expires_at: "2026-09-30T00:00:00.000Z" })),
      ...client,
    },
    copyText: vi.fn(() => true),
    copyBytes: vi.fn(() => true),
    exists: vi.fn(() => false),
    writeFile: vi.fn(),
    home: "/home/u",
    look: { color: "none", icons: false, animations: false },
    now: () => Date.parse("2026-09-22T12:00:00.000Z"),
    ...over,
  };
}
const H = 5;
const withA = (): State => withItems(initialState(), [item("a", "a.png"), item("b", "b.txt", "text/plain")], H);
const gone = () => { throw new DripError(404, "gone"); };

describe("contentKind", () => {
  it("classifies images, text-like types and everything else", () => {
    expect(contentKind("image/png")).toBe("image");
    expect(contentKind("text/plain; charset=utf-8")).toBe("text");
    expect(contentKind("application/json")).toBe("text");
    expect(contentKind("application/vnd.api+json")).toBe("text");
    expect(contentKind("application/pdf")).toBe("other");
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~/x.png", "/home/u")).toBe("/home/u/x.png");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("./~x", "/home/u")).toBe("./~x");
  });
});

describe("runEffect", () => {
  it("copy-url reports success and failure", async () => {
    expect((await runEffect({ kind: "copy-url", item: item("a", "a.png") }, withA(), deps(), H)).status).toBe("copied url · paste it to your agent");
    const d = deps({ copyText: vi.fn(() => false) });
    expect((await runEffect({ kind: "copy-url", item: item("a", "a.png") }, withA(), d, H)).status).toBe("clipboard unavailable — https://h/f/a/a.png");
  });

  it("copy-contents puts an image on the clipboard with its bare type", async () => {
    const d = deps();
    const s = await runEffect({ kind: "copy-contents", item: item("a", "a.png") }, withA(), d, H);
    expect(d.copyBytes).toHaveBeenCalledWith(BYTES, "image/png");
    expect(s).toMatchObject({ status: "copied 2 B image", statusKind: "ok" });
  });

  it("copy-contents falls back to the url when the image cannot be copied", async () => {
    const d = deps({ copyBytes: vi.fn(() => false) });
    const s = await runEffect({ kind: "copy-contents", item: item("a", "a.png") }, withA(), d, H);
    expect(d.copyText).toHaveBeenCalledWith("https://h/f/a/a.png");
    expect(s).toMatchObject({ status: "could not copy image/png image; copied url", statusKind: "warn" });
  });

  it("copy-contents copies text as text", async () => {
    const d = deps();
    const s = await runEffect({ kind: "copy-contents", item: item("b", "b.txt", "text/plain") }, withA(), d, H);
    expect(d.copyText).toHaveBeenCalledWith("hi");
    expect(s.status).toBe("copied 2 B text");
  });

  it("copy-contents copies the url for other types without downloading", async () => {
    const d = deps();
    const s = await runEffect({ kind: "copy-contents", item: item("p", "p.pdf", "application/pdf") }, withA(), d, H);
    expect(d.client.get).not.toHaveBeenCalled();
    expect(s.status).toBe("no clipboard support for application/pdf; copied url");
  });

  it("save refuses to overwrite", async () => {
    const d = deps({ exists: vi.fn(() => true) });
    const s = await runEffect({ kind: "save", item: item("a", "a.png"), path: "./a.png" }, withA(), d, H);
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(s).toMatchObject({ status: "refusing to overwrite ./a.png", statusKind: "warn" });
  });

  it("save downloads and writes, expanding ~", async () => {
    const d = deps();
    const s = await runEffect({ kind: "save", item: item("a", "a.png"), path: "~/a.png" }, withA(), d, H);
    expect(d.writeFile).toHaveBeenCalledWith("/home/u/a.png", BYTES);
    expect(s.status).toBe("saved ~/a.png");
  });

  it("a 404 on get drops the row", async () => {
    const d = deps({}, { get: vi.fn(gone) });
    const s = await runEffect({ kind: "save", item: item("a", "a.png"), path: "./a.png" }, withA(), d, H);
    expect(s.items.map((i) => i.id)).toEqual(["b"]);
    expect(s.status).toBe("expired or already deleted");
  });

  it("delete removes the row", async () => {
    const d = deps();
    const s = await runEffect({ kind: "delete", item: item("a", "a.png") }, withA(), d, H);
    expect(d.client.delete).toHaveBeenCalledWith("a");
    expect(s.items.map((i) => i.id)).toEqual(["b"]);
    expect(s.status).toBe("deleted a.png");
  });

  it("refresh loads LIST_LIMIT items; an error still ends loading", async () => {
    const d = deps();
    const s = await runEffect({ kind: "refresh" }, initialState(), d, H);
    expect(d.client.list).toHaveBeenCalledWith(LIST_LIMIT);
    expect(s).toMatchObject({ loading: false, online: true, status: "1 drips synced", statusKind: "ok", anim: null });
    const bad = deps({}, { list: vi.fn(async () => { throw new Error("fetch failed"); }) });
    expect(await runEffect({ kind: "refresh" }, initialState(), bad, H))
      .toMatchObject({ loading: false, online: false, status: "fetch failed", statusKind: "err" });
    // The server answering with an error is still a server that answered.
    const refused = deps({}, { list: vi.fn(async () => { throw new DripError(500, "list failed: 500"); }) });
    expect((await runEffect({ kind: "refresh" }, initialState(), refused, H)).online).toBeUndefined();
  });

  it("set-ttl swaps in the server's copy and says when it now expires", async () => {
    const d = deps();
    const s = await runEffect({ kind: "set-ttl", item: item("a", "a.png"), ttl: "7d" }, withA(), d, H);
    expect(d.client.setTtl).toHaveBeenCalledWith("a", "7d");
    expect(s.items.find((i) => i.id === "a")!.expires_at).toBe("2026-09-30T00:00:00.000Z");
    expect(s).toMatchObject({ status: "a.png now expires in 7d", statusKind: "ok" });
    // A server with a lower max ttl caps it: report what it actually did.
    const capped = deps({}, { setTtl: vi.fn(async () => ({ ...item("a", "a.png"), expires_at: "2026-09-24T12:00:00.000Z" })) });
    expect((await runEffect({ kind: "set-ttl", item: item("a", "a.png"), ttl: "7d" }, withA(), capped, H)).status).toBe("a.png now expires in 2d");
    const g = await runEffect({ kind: "set-ttl", item: item("a", "a.png"), ttl: "1h" }, withA(), deps({}, { setTtl: vi.fn(gone) }), H);
    expect(g).toMatchObject({ status: "expired or already deleted" });
    expect(g.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("starts the refresh reveal and the copy splash only when animations are on", async () => {
    const on = deps({ look: { color: "none", icons: false, animations: true } });
    expect((await runEffect({ kind: "refresh" }, initialState(), on, H)).anim).toEqual({ kind: "refresh", frame: 0 });
    expect((await runEffect({ kind: "copy-url", item: item("a", "a.png") }, withA(), on, H)).anim).toEqual({ kind: "copy", frame: 0 });
    expect((await runEffect({ kind: "copy-contents", item: item("p", "p.pdf", "application/pdf") }, withA(), on, H)).anim).toBeNull();
    expect((await runEffect({ kind: "copy-url", item: item("a", "a.png") }, withA(), deps(), H)).anim).toBeNull();
  });
});

describe("runTui", () => {
  function fakeTerm() {
    let onKeys: (keys: Key[]) => void = () => {};
    const writes: string[] = [];
    const term: Terminal = {
      cols: 80, rows: 10,
      write: (s) => { writes.push(s); },
      onKeys: (cb) => { onKeys = cb; },
      onResize: () => {},
      close: () => {},
    };
    return { term, writes, press: (...keys: Key[]) => onKeys(keys) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("loads, draws, copies on y and resolves on q", async () => {
    const { term, writes, press } = fakeTerm();
    const d = deps();
    const done = runTui(term, d, "h");
    await tick();
    expect(writes.at(-1)!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).toContain("a.png");
    press({ name: "char", ch: "y" }, { name: "char", ch: "q" });
    await done;
    expect(d.copyText).toHaveBeenCalledWith("https://h/f/a/a.png");
  });

  it("animates the refresh with a frame timer that stops when nothing moves", async () => {
    const { term, writes, press } = fakeTerm();
    const done = runTui(term, deps({ look: { color: "none", icons: false, animations: true } }), "h");
    await tick();
    const plain = (w: string) => w.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain(writes.at(-1)!)).not.toContain("a.png"); // frame 0: rows still hidden
    await new Promise((r) => setTimeout(r, 70 * 16));
    expect(plain(writes.at(-1)!)).toContain("a.png");
    const settled = writes.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(writes.length).toBe(settled);
    press({ name: "char", ch: "q" });
    await done;
  });

  it("fades a finished status after fadeMs", async () => {
    const { term, writes, press } = fakeTerm();
    const done = runTui(term, deps({ fadeMs: 20 }), "h");
    await tick();
    press({ name: "char", ch: "y" });
    await tick();
    expect(writes.at(-1)).toContain("copied url");
    await new Promise((r) => setTimeout(r, 60));
    expect(writes.at(-1)).not.toContain("copied url");
    press({ name: "char", ch: "q" });
    await done;
  });
});

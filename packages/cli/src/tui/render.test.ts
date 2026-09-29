import { describe, it, expect } from "vitest";
import type { FileListItem } from "@drip/shared";
import { initialState, withItems, withStatus, reduce, type State } from "./state.js";
import { listHeight, paint, render } from "./render.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const HOUR = 3600_000;
const item = (id: string, filename: string, o: Partial<FileListItem> = {}): FileListItem => ({
  id, filename, content_type: "image/png", url: `https://drip.example/f/${id}/${filename}`, size: 2048,
  created_at: new Date(NOW - HOUR).toISOString(), expires_at: new Date(NOW + 23 * HOUR).toISOString(), ...o,
});
const strip = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const width = (l: string) => [...strip(l)].length;
const loaded = (n: number, rows = 20): State =>
  withItems(initialState(), Array.from({ length: n }, (_, i) => item(`id${i}`, `file${i}-${"x".repeat(60)}.png`)), listHeight(rows));
const text = (lines: string[]) => lines.map(strip).join("\n");
const key = (s: State, ch: string, rows = 20) => reduce(s, ch.length === 1 ? { name: "char", ch } : { name: ch as "down" }, listHeight(rows)).state;

describe("paint", () => {
  it("truncates across spans with an ellipsis", () => {
    expect(strip(paint([{ text: "abc" }, { text: "defg", style: "2" }], 5, true))).toBe("abcd…");
  });
  it("pads to width when a background is given, and styles every span with it", () => {
    const out = paint([{ text: "ab", style: "35" }], 5, true, { bg: "100" });
    expect(width(out)).toBe(5);
    expect(out).toContain("\x1b[35;100m");
  });
  it("drops colours but keeps attributes when colour is off", () => {
    expect(paint([{ text: "a", style: "1;35" }], 5, false)).toBe("\x1b[1ma\x1b[0m");
    expect(paint([{ text: "a" }], 3, false, { bg: "100" })).toBe("\x1b[7ma\x1b[0m\x1b[7m  \x1b[0m");
  });
});

describe("render layout", () => {
  it("returns exactly rows lines, none wider than cols, with and without the details pane", () => {
    for (const [cols, rows] of [[20, 6], [60, 10], [80, 24], [109, 30], [110, 30], [200, 50]] as const) {
      for (const color of [true, false]) {
        const lines = render(loaded(40, rows), cols, rows, NOW, "drip.example.com", color);
        expect(lines).toHaveLength(rows);
        for (const l of lines) expect(width(l)).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("has a header, rules and column labels on a normal-height terminal", () => {
    const lines = render(loaded(3), 80, 20, NOW, "drip.example.com").map(strip);
    expect(lines[0]).toMatch(/^ drip {2}drip\.example\.com +3 drips · 1–3$/);
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toMatch(/^\s+AGE\s+SIZE\s+EXPIRES {2}NAME/);
    expect(lines[3]).toMatch(/^▌\s+1h\s+2\.0 KB\s+23h {2}file0-/);
    expect(lines[4]).toMatch(/^ \s+1h/);
    expect(lines.at(-3)).toMatch(/^─+$/);
  });

  it("drops rules and labels on a short terminal", () => {
    const lines = render(loaded(3, 8), 80, 8, NOW, "h").map(strip);
    expect(lines[1]).toMatch(/^▌/);
    expect(listHeight(8)).toBe(5);
  });

  it("shows the visible range when scrolled", () => {
    let s = loaded(40);
    for (let i = 0; i < 30; i++) s = key(s, "down");
    const lines = render(s, 80, 20, NOW, "h").map(strip);
    expect(lines[0]).toMatch(/40 drips · 18–31$/);
    expect(lines.find((l) => l.startsWith("▌"))).toContain("file30-");
  });

  it("explains empty states", () => {
    expect(text(render(initialState(), 80, 20, NOW, "h"))).toContain("loading…");
    expect(text(render(withItems(initialState(), [], 3), 80, 20, NOW, "h"))).toContain("no drips yet");
  });
});

describe("colour", () => {
  const one = (o: Partial<FileListItem>, name = "a.png") =>
    render(withItems(initialState(), [item("a", name, o), item("b", "b.txt")], 10), 80, 20, NOW, "h", true);

  it("colours the filename by type and dims its extension", () => {
    const lines = render(withItems(initialState(), [item("b", "b.txt"), item("a", "a.png"), item("c", "c.txt", { content_type: "text/plain" })], 10), 80, 20, NOW, "h");
    expect(lines[4]).toContain("\x1b[35ma");
    expect(lines[5]).toContain("\x1b[32mc\x1b[0m\x1b[2m.txt");
  });

  it("warns about expiry under 6h and alarms under 1h", () => {
    expect(one({ expires_at: new Date(NOW + 3 * HOUR).toISOString() })[3]).toMatch(/33;100m\s+3h/);
    expect(one({ expires_at: new Date(NOW + 20 * 60_000).toISOString() })[3]).toMatch(/1;31;100m\s+20m/);
  });

  it("marks the selection with a background bar", () => {
    expect(one({})[3]).toContain(";100m");
  });

  it("has no colour codes when colour is off", () => {
    const all = render(loaded(3), 120, 20, NOW, "h", false).join("");
    expect(all).not.toMatch(/\x1b\[[0-9;]*(3[0-7]|9[0-7]|4[0-7]|10[0-7])(;[0-9]+)*m/);
    expect(all).toContain("\x1b[7m");
  });
});

describe("status and prompts", () => {
  const statusLine = (s: State, cols = 80) => strip(render(s, cols, 20, NOW, "h").at(-2)!);

  it("prefixes status by kind", () => {
    expect(statusLine(withStatus(loaded(1), "copied url", "ok"))).toBe(" ✓ copied url");
    expect(statusLine(withStatus(loaded(1), "boom", "err"))).toBe(" ✗ boom");
    expect(statusLine(withStatus(loaded(1), "hmm", "warn"))).toBe(" ! hmm");
    expect(statusLine(withStatus(loaded(1), "working…", "busy"))).toBe(" … working…");
  });

  it("filter prompt shows a cursor and keeps the tail of long input", () => {
    let s = key(loaded(1), "/");
    for (const c of "abcdefghij") s = key(s, c);
    expect(statusLine(s, 10)).toBe(" / …fghij ");
  });

  it("save-as prompt keeps its label", () => {
    expect(statusLine(key(loaded(1), "S"))).toMatch(/^ save to …(ile0-)?x+\.png $/);
  });

  it("delete confirm names the file", () => {
    expect(statusLine(key(withItems(initialState(), [item("a", "a.png")], 10), "d"))).toBe(" delete a.png? y/N");
  });
});

describe("footer", () => {
  const footer = (cols: number) => strip(render(loaded(1), cols, 20, NOW, "h").at(-1)!);
  it("shows every hint when there is room", () => {
    expect(footer(120)).toBe(" ↑↓ move  ⏎ url  c copy  s save  S save as  d delete  / filter  r refresh  q quit");
  });
  it("sheds low-priority hints instead of wrapping", () => {
    const f = footer(40);
    expect([...f].length).toBeLessThanOrEqual(40);
    expect(f).toContain("⏎ url");
    expect(f).toContain("q quit");
    expect(f).not.toContain("refresh");
  });
});

describe("details pane", () => {
  it("appears at 110 columns and shows the selected drip", () => {
    const s = withItems(initialState(), [item("abc123", "shot.png", { size: 80_000 })], 10);
    const out = text(render(s, 140, 20, NOW, "drip.example.com"));
    expect(out).toContain("│");
    expect(out).toMatch(/DETAILS/);
    expect(out).toMatch(/type +image\/png/);
    expect(out).toMatch(/size +78\.1 KB \(80,000 bytes\)/);
    expect(out).toMatch(/expires .*in 23h/);
    expect(out).toContain("abc123");
    expect(out).toContain("https://drip.example/f/abc123/shot.png");
  });
  it("is absent below 110 columns", () => {
    expect(text(render(loaded(2), 109, 20, NOW, "h"))).not.toContain("DETAILS");
  });
  it("follows the selection", () => {
    const s = key(withItems(initialState(), [item("a", "one.png"), item("b", "two.txt", { content_type: "text/plain" })], 10), "j");
    expect(text(render(s, 140, 20, NOW, "h"))).toMatch(/type +text\/plain/);
  });
});

import { describe, it, expect } from "vitest";
import type { FileListItem } from "@drip/shared";
import { initialState, withItems, withStatus, reduce, startAnim, type State } from "./state.js";
import { DEFAULT_LOOK, listHeight, lookFromEnv, paint, render, type Look } from "./render.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const HOUR = 3600_000;
const item = (id: string, filename: string, o: Partial<FileListItem> = {}): FileListItem => ({
  id, filename, content_type: "image/png", url: `https://drip.example/f/${id}/${filename}`, size: 2048,
  created_at: new Date(NOW - HOUR).toISOString(), expires_at: new Date(NOW + 23 * HOUR).toISOString(), ...o,
});
const strip = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const width = (l: string) => [...strip(l)].length;
/** Plain text, no Nerd Font glyphs, nothing moving: what the layout tests read. */
const PLAIN: Look = { color: "none", icons: false, animations: false };
const ANSI: Look = { color: "ansi16", icons: false, animations: false };
const flat = (s: State): State => ({ ...s, grouping: "none" });
const fill = (items: FileListItem[], rows = 20) => flat(withItems(initialState(), items, listHeight(rows), NOW));
const loaded = (n: number, rows = 20): State =>
  fill(Array.from({ length: n }, (_, i) => item(`id${i}`, `file${i}-${"x".repeat(60)}.png`)), rows);
const text = (lines: string[]) => lines.map(strip).join("\n");
const key = (s: State, ch: string, rows = 20) => reduce(s, ch.length === 1 ? { name: "char", ch } : { name: ch as "down" }, listHeight(rows)).state;
const draw = (s: State, cols = 80, rows = 20, look = PLAIN, host = "h") => render(s, cols, rows, NOW, host, look);

describe("paint", () => {
  it("truncates across spans with an ellipsis", () => {
    expect(strip(paint([{ text: "abc" }, { text: "defg", fg: "dim" }], 5, "ansi16"))).toBe("abcd…");
  });
  it("pads to width when a background is given, and styles every span with it", () => {
    const out = paint([{ text: "ab", fg: "lilac" }], 5, "ansi16", { bg: "sel" });
    expect(width(out)).toBe(5);
    expect(out).toContain("\x1b[35;100m");
  });
  it("lets a span's own background win over the line's", () => {
    expect(paint([{ text: "k", bg: "chip" }], 1, "truecolor", { bg: "sel" })).toBe("\x1b[48;2;17;33;44mk\x1b[0m");
  });
  it("uses 24-bit codes in truecolor and leaves plain text in the terminal's colour", () => {
    expect(paint([{ text: "a", fg: "aqua", bold: true }, { text: "b" }], 2, "truecolor")).toBe("\x1b[1;38;2;80;217;239ma\x1b[0mb");
  });
  it("drops colours but keeps attributes when colour is off", () => {
    expect(paint([{ text: "a", fg: "lilac", bold: true }], 5, "none")).toBe("\x1b[1ma\x1b[0m");
    expect(paint([{ text: "a" }], 3, "none", { bg: "sel" })).toBe("\x1b[7ma\x1b[0m\x1b[7m  \x1b[0m");
  });
});

describe("lookFromEnv", () => {
  it("picks truecolor from COLORTERM, else the 16-colour palette", () => {
    expect(lookFromEnv({ COLORTERM: "truecolor" })).toEqual(DEFAULT_LOOK);
    expect(lookFromEnv({ COLORTERM: "24bit" }).color).toBe("truecolor");
    expect(lookFromEnv({}).color).toBe("ansi16");
  });
  it("honours DRIP_PALETTE, NO_COLOR and TERM=dumb", () => {
    expect(lookFromEnv({ COLORTERM: "truecolor", DRIP_PALETTE: "ansi" }).color).toBe("ansi16");
    expect(lookFromEnv({ DRIP_PALETTE: "truecolor" }).color).toBe("truecolor");
    expect(lookFromEnv({ NO_COLOR: "1", COLORTERM: "truecolor" }).color).toBe("none");
    expect(lookFromEnv({ TERM: "dumb" })).toMatchObject({ color: "none", icons: false });
  });
  it("turns icons and animations off on request", () => {
    expect(lookFromEnv({ DRIP_ICONS: "0", DRIP_ANIMATIONS: "off" })).toMatchObject({ icons: false, animations: false });
    expect(lookFromEnv({ DRIP_ICONS: "1" }).icons).toBe(true);
  });
});

describe("render layout", () => {
  it("returns exactly rows lines, none wider than cols, in every look", () => {
    const looks: Look[] = [PLAIN, ANSI, DEFAULT_LOOK];
    for (const [cols, rows] of [[20, 6], [60, 10], [80, 24], [109, 30], [110, 30], [200, 50]] as const) {
      for (const look of looks) {
        for (const s of [loaded(40, rows), { ...loaded(40, rows), grouping: "time" as const }]) {
          const lines = draw(s, cols, rows, look, "drip.example.com");
          expect(lines).toHaveLength(rows);
          for (const l of lines) expect(width(l)).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  it("has a header, rules and column labels on a normal-height terminal", () => {
    const lines = draw(loaded(3), 80, 20, PLAIN, "drip.example.com").map(strip);
    expect(lines[0]).toMatch(/^ drip {3}drip\.example\.com {2}● tailnet +flat {3}3 drips · 6\.0 KB$/);
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toMatch(/^\s+AGE\s+SIZE\s+EXPIRES {2}NAME/);
    expect(lines[3]).toMatch(/^▌ \s+1h\s+2\.0 KB\s+23h {2}file0-/);
    expect(lines[4]).toMatch(/^ {2}\s+1h/);
    expect(lines.at(-3)).toMatch(/^─+$/);
  });

  it("lines the column labels up with the columns, with and without icons", () => {
    for (const look of [PLAIN, DEFAULT_LOOK]) {
      const [labels, row] = draw(loaded(1), 80, 20, look).map(strip).slice(2, 4);
      for (const col of ["AGE", "SIZE", "EXPIRES"]) {
        const end = labels!.indexOf(col) + col.length;
        expect(row![end - 1]).not.toBe(" ");
        expect(row![end]).toBe(" ");
      }
    }
  });

  it("drops rules and labels on a short terminal", () => {
    const lines = draw(loaded(3, 8), 80, 8).map(strip);
    expect(lines[1]).toMatch(/^▌/);
    expect(listHeight(8)).toBe(5);
  });

  it("scrolls to keep the selection in view", () => {
    let s = loaded(40);
    for (let i = 0; i < 30; i++) s = key(s, "down");
    expect(draw(s).map(strip).find((l) => l.startsWith("▌"))).toContain("file30-");
  });

  it("explains empty states", () => {
    expect(text(draw(withItems(initialState(), [], 3)))).toContain("no drips yet");
    expect(text(draw({ ...loaded(2), filter: "zzz" }))).toContain("no matches");
  });

  it("shows the server's reachability in the header", () => {
    expect(strip(draw(initialState())[0]!)).toContain("● connecting");
    expect(strip(draw({ ...loaded(1), online: false })[0]!)).toContain("● offline");
    expect(draw({ ...loaded(1), online: false }, 80, 20, ANSI)[0]).toContain("\x1b[31m●");
  });

  it("shows the filter, the count of matches and the grouping", () => {
    const head = strip(draw({ ...loaded(3), filter: "file1" })[0]!);
    expect(head).toMatch(/\/ file1 {3}flat {3}1\/3 drips · 6\.0 KB$/);
    expect(strip(draw({ ...loaded(3), grouping: "type" })[0]!)).toContain("by type");
  });
});

describe("groups", () => {
  const mixed = () => withItems(initialState(), [
    item("n", "new.png", { created_at: new Date(NOW - 60_000).toISOString() }),
    item("o", "old.txt", { content_type: "text/plain", created_at: new Date(NOW - 30 * HOUR).toISOString() }),
    item("p", "doc.pdf", { content_type: "application/pdf", created_at: new Date(NOW - 2 * HOUR).toISOString() }),
  ], listHeight(20), NOW);

  it("heads each time group with its name, count and a rule", () => {
    const out = draw(mixed()).map(strip);
    expect(out[3]).toMatch(/^ {2}▾ LAST HOUR 1 ─+$/);
    expect(out[4]).toMatch(/^▌ .*new\.png/);
    expect(out[5]).toMatch(/^ {2}▾ EARLIER TODAY 1 ─+$/);
    expect(out[7]).toMatch(/^ {2}▾ BEFORE TODAY 1 ─+$/);
    expect(width(draw(mixed())[3]!)).toBe(80);
  });

  it("groups by type after a tab and keeps the selected drip", () => {
    const s = key(key(mixed(), "j"), "tab");
    const out = draw(s).map(strip);
    expect(out.filter((l) => l.includes("▾")).map((l) => l.trim().split(" ─")[0])).toEqual(["▾ IMAGES 1", "▾ TEXT 1", "▾ OTHER 1"]);
    expect(out.find((l) => l.startsWith("▌"))).toContain("doc.pdf");
  });
});

describe("colour", () => {
  const one = (o: Partial<FileListItem>, name = "a.png", look = ANSI) => draw(fill([item("a", name, o), item("b", "b.txt")]), 80, 20, look);

  it("colours the filename by type and dims its extension", () => {
    const lines = draw(fill([item("b", "b.txt"), item("a", "a.png"), item("c", "c.txt", { content_type: "text/plain" })]), 80, 20, ANSI);
    expect(lines[4]).toContain("\x1b[35ma");
    expect(lines[5]).toContain("\x1b[32mc\x1b[0m\x1b[2m.txt");
  });

  it("warns about expiry under 6h and alarms under 1h", () => {
    expect(one({ expires_at: new Date(NOW + 3 * HOUR).toISOString() })[3]).toMatch(/33;100m\s+3h/);
    expect(one({ expires_at: new Date(NOW + 20 * 60_000).toISOString() })[3]).toMatch(/1;31;100m\s+20m/);
  });

  it("puts an hourglass on soon-to-expire drips only when icons are on", () => {
    const soon = { expires_at: new Date(NOW + 3 * HOUR).toISOString() };
    expect(strip(one(soon, "a.png", DEFAULT_LOOK)[3]!)).toContain("\uF252 3h");
    expect(strip(one({}, "a.png", DEFAULT_LOOK)[3]!)).not.toContain("\uF252");
    expect(strip(one(soon)[3]!)).not.toContain("\uF252");
  });

  it("marks the selection with a background bar", () => {
    expect(one({})[3]).toContain(";100m");
    expect(one({}, "a.png", DEFAULT_LOOK)[3]).toContain(";48;2;10;39;55m");
  });

  it("has no colour codes when colour is off", () => {
    const all = draw(loaded(3), 120, 20, PLAIN).join("");
    expect(all).not.toMatch(/\x1b\[[0-9;]*(3[0-8]|9[0-7]|4[0-8]|10[0-7])(;[0-9]+)*m/);
    expect(all).toContain("\x1b[7m");
  });
});

describe("icons", () => {
  it("draws the pill caps, the drop and file icons with icons on, and none of them off", () => {
    const on = text(draw(loaded(1), 140, 30, DEFAULT_LOOK));
    for (const g of ["\uE0B6", "\uF043 drip", "\uE0B4", "\uF1C5", "\uF0C1 url"]) expect(on).toContain(g);
    expect(text(draw(loaded(1), 140, 30, PLAIN))).not.toMatch(/[\uE000-\uF8FF]/);
  });
});

describe("status and prompts", () => {
  const statusLine = (s: State, cols = 80, look = PLAIN) => strip(draw(s, cols, 20, look).at(-2)!);

  it("prefixes status by kind", () => {
    expect(statusLine(withStatus(loaded(1), "copied url", "ok"))).toBe(" ✓ copied url");
    expect(statusLine(withStatus(loaded(1), "boom", "err"))).toBe(" ✗ boom");
    expect(statusLine(withStatus(loaded(1), "hmm", "warn"))).toBe(" ! hmm");
    expect(statusLine(withStatus(loaded(1), "grouped by type"))).toBe(" · grouped by type");
    expect(statusLine(withStatus(loaded(1), "working…", "busy"))).toBe(" … working…");
  });

  it("spins while busy or loading when animations are on", () => {
    const look = { ...PLAIN, animations: true };
    expect(statusLine({ ...withStatus(loaded(1), "working…", "busy"), tick: 1 }, 80, look)).toBe(" ⠂ working…");
    expect(statusLine({ ...initialState(), tick: 2 }, 80, look)).toBe(" ⠄ dripping in from h…");
  });

  it("plays the splash in the icon slot after a copy, then settles on the tick", () => {
    const look = { ...PLAIN, animations: true };
    const s = startAnim(withStatus(loaded(1), "copied url", "ok"), "copy");
    expect(statusLine(s, 80, look)).toBe(" · copied url");
    expect(statusLine({ ...s, anim: { kind: "copy", frame: 3 } }, 80, look)).toBe(" ✺ copied url");
    expect(statusLine({ ...s, anim: null }, 80, look)).toBe(" ✓ copied url");
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
    expect(statusLine(key(fill([item("a", "a.png")]), "d"))).toBe(" delete a.png? y/N");
  });

  it("ttl picker shows the choices, the pick and when it would expire", () => {
    const s = key(fill([item("a", "a.png")]), "t");
    expect(statusLine(s, 100)).toMatch(/^ keep a\.png for {3}1h {3}6h {3}24h {3}3d {3}7d {3}→ expires \d{4}-\d\d-\d\d \d\d:\d\d · in 24h$/);
    expect(draw(s, 100, 20, ANSI).at(-2)).toContain("\x1b[1;30;46m 24h \x1b[0m");
    const narrow = statusLine(s, 60);
    expect([...narrow].length).toBeLessThanOrEqual(60);
    expect(narrow).toContain("24h");
  });
});

describe("footer", () => {
  const footer = (cols: number, s = loaded(1)) => strip(draw(s, cols).at(-1)!);
  it("shows every hint when there is room", () => {
    expect(footer(140)).toBe(
      "  ↑↓  move   ⏎  url   c  copy   s  save   S  save as   t  ttl   d  delete   /  filter   ⇥  group   r  refresh   q  quit",
    );
  });
  it("sheds low-priority hints instead of wrapping", () => {
    const f = footer(50);
    expect([...f].length).toBeLessThanOrEqual(50);
    expect(f).toContain("⏎  url");
    expect(f).toContain("q  quit");
    expect(f).not.toContain("refresh");
  });
  it("shows the ttl picker's keys in ttl mode", () => {
    expect(footer(80, key(loaded(1), "t"))).toBe("  ←→  pick   1-5  jump   ⏎  set   esc  cancel");
  });
  it("draws keys as chips", () => {
    expect(draw(loaded(1), 140, 20, DEFAULT_LOOK).at(-1)).toContain("\x1b[1;38;2;80;217;239;48;2;17;33;44m q \x1b[0m");
  });
});

describe("details pane", () => {
  it("appears at 110 columns and shows the selected drip", () => {
    const s = fill([item("abc123", "shot.png", { size: 80_000 })]);
    const out = text(draw(s, 140, 20, PLAIN, "drip.example.com"));
    expect(out).toContain("│");
    expect(out).toMatch(/│ shot\.png/);
    expect(out).toMatch(/image · dripped 1h ago/);
    expect(out).toMatch(/type +image\/png/);
    expect(out).toMatch(/size +78\.1 KB \(80,000 bytes\)/);
    expect(out).toMatch(/expires .*in 23h/);
    expect(out).toMatch(/ttl +█+░+ 96% left/);
    expect(out).toContain("abc123");
    expect(out).toContain("https://drip.example/f/abc123/shot.png");
  });
  it("is absent below 110 columns", () => {
    expect(text(draw(loaded(2), 109))).not.toContain("dripped");
  });
  it("follows the selection", () => {
    const s = key(fill([item("a", "one.png"), item("b", "two.txt", { content_type: "text/plain" })]), "j");
    expect(text(draw(s, 140))).toMatch(/type +text\/plain/);
  });
  it("adds a QR code of the url only when it fits whole", () => {
    const s = fill([item("a", "a.png")]);
    const tall = text(draw(s, 140, 40));
    expect(tall).toContain("scan to fetch on another device");
    expect(tall).toMatch(/│ {2}[█▀▄ ]{20,}/);
    expect(text(draw(s, 140, 20))).not.toContain("scan to fetch");
  });
  it("flashes the url and the selected row on a copy", () => {
    const s = startAnim(withStatus(fill([item("a", "a.png")]), "copied url", "ok"), "copy");
    const look = { ...DEFAULT_LOOK, animations: true };
    const out = draw(s, 140, 20, look).join("\n");
    expect(out.match(/48;2;0;78;93m/g)!.length).toBeGreaterThan(2);
    expect(draw({ ...s, anim: null }, 140, 20, look).join("\n")).not.toContain("48;2;0;78;93m");
  });
});

describe("refresh reveal", () => {
  it("fades rows in top to bottom: hidden, then faint, then whole", () => {
    const look = { ...PLAIN, animations: true };
    const s = startAnim(loaded(12), "refresh");
    const rowsAt = (frame: number) => draw({ ...s, anim: { kind: "refresh", frame } }, 80, 20, look).slice(3, 15).map(strip);
    expect(rowsAt(0).filter((l) => l.includes("file")).length).toBe(1);
    expect(rowsAt(6).filter((l) => l.includes("file")).length).toBe(7);
    expect(draw({ ...s, anim: { kind: "refresh", frame: 6 } }, 80, 20, { ...ANSI, animations: true })[9]).toContain("\x1b[90m");
    expect(rowsAt(13).filter((l) => l.includes("file")).length).toBe(12);
    expect(draw(s, 80, 20, PLAIN).slice(3, 15).filter((l) => l.includes("file")).length).toBe(12);
  });
});

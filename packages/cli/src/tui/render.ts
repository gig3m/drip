import type { FileListItem } from "@drip/shared";
import { humanAge, humanSize } from "../format.js";
import { contentKind } from "./kind.js";
import { visibleItems, type State, type StatusKind } from "./state.js";

// ---- styling ---------------------------------------------------------------
//
// Styles are SGR parameter strings ("1;36"). Colours come from the terminal's own
// 16-colour palette, so the TUI follows whatever theme the terminal runs.

export interface Span { text: string; style?: string }

const A = {
  accent: "36", pill: "1;30;46", key: "1;36", dim: "2", bold: "1",
  image: "35", text: "32", warn: "33", alarm: "1;31",
  ok: "1;32", err: "1;31", errText: "31", selBg: "100", cursor: "7",
} as const;

const COLOUR = /^(3[0-9]|9[0-7]|4[0-9]|10[0-7])$/;

/** With colour off (NO_COLOR), keep attributes; the selection bar becomes reverse video. */
function sgr(style: string | undefined, color: boolean): string {
  if (!style) return "";
  return style
    .split(";")
    .map((p) => (!color && p === A.selBg ? "7" : p))
    .filter((p) => p && (color || !COLOUR.test(p)))
    .join(";");
}

const len = (t: string) => [...t].length;

/**
 * Lay spans into at most `width` columns, ending with "…" when they overflow.
 * With `bg`, every span also gets the background and the line is padded to `width`.
 */
export function paint(spans: Span[], width: number, color: boolean, opts: { bg?: string; pad?: boolean } = {}): string {
  if (width <= 0) return "";
  const total = spans.reduce((n, sp) => n + len(sp.text), 0);
  const overflow = total > width;
  let left = overflow ? width - 1 : width;
  const pieces: Span[] = [];
  for (const sp of spans) {
    if (left <= 0) break;
    const take = [...sp.text].slice(0, left);
    if (take.length) pieces.push({ text: take.join(""), style: sp.style });
    left -= take.length;
  }
  if (overflow) pieces.push({ text: "…", style: pieces.at(-1)?.style });
  const used = overflow ? width : total;
  if ((opts.bg || opts.pad) && used < width) pieces.push({ text: " ".repeat(width - used) });
  return pieces
    .map((p) => {
      const code = sgr([p.style, opts.bg].filter(Boolean).join(";"), color);
      return code ? `\x1b[${code}m${p.text}\x1b[0m` : p.text;
    })
    .join("");
}

const spansLen = (spans: Span[]) => spans.reduce((n, sp) => n + len(sp.text), 0);

/** Left spans, then right spans flush right — or left alone when both don't fit. */
function leftRight(left: Span[], right: Span[], width: number): Span[] {
  const gap = width - spansLen(left) - spansLen(right);
  return gap >= 1 ? [...left, { text: " ".repeat(gap) }, ...right] : left;
}

// ---- layout ----------------------------------------------------------------

/** Below this height the rules and column labels are dropped to keep rows for the list. */
const COMPACT_BELOW = 12;
const PANE_MIN_COLS = 110;

/** Rows available for the list. */
export function listHeight(rows: number): number {
  return Math.max(1, rows - (rows < COMPACT_BELOW ? 3 : 6));
}

const typeStyle = (ct: string) => {
  const k = contentKind(ct);
  return k === "image" ? A.image : k === "text" ? A.text : undefined;
};

function expiryStyle(ms: number): string {
  if (ms < 3600_000) return A.alarm;
  if (ms < 6 * 3600_000) return A.warn;
  return A.dim;
}

function nameSpans(it: FileListItem): Span[] {
  const dot = it.filename.lastIndexOf(".");
  const style = typeStyle(it.content_type);
  if (dot <= 0) return [{ text: it.filename, style }];
  return [{ text: it.filename.slice(0, dot), style }, { text: it.filename.slice(dot), style: A.dim }];
}

const COLS = { age: 4, size: 9, expires: 7 };

function rowSpans(it: FileListItem, selected: boolean, now: number): Span[] {
  const expiresIn = Date.parse(it.expires_at) - now;
  return [
    selected ? { text: "▌", style: A.accent } : { text: " " },
    { text: " " + humanAge(now - Date.parse(it.created_at)).padStart(COLS.age), style: A.dim },
    { text: "  " + humanSize(it.size).padStart(COLS.size) },
    { text: "  " + humanAge(expiresIn).padStart(COLS.expires), style: expiryStyle(expiresIn) },
    { text: "  " },
    ...nameSpans(it),
  ];
}

const LABELS: Span[] = [{
  text: "  " + "AGE".padStart(COLS.age) + "  " + "SIZE".padStart(COLS.size) + "  " + "EXPIRES".padStart(COLS.expires) + "  NAME",
  style: A.dim,
}];

function header(s: State, visible: number, height: number, host: string, width: number): Span[] {
  const count = s.filter ? `${visible}/${s.items.length} drips` : `${s.items.length} drips`;
  const range = visible > 0 ? ` · ${s.scroll + 1}–${Math.min(s.scroll + height, visible)}` : "";
  const right: Span[] = [];
  if (s.filter) right.push({ text: "filter ", style: A.dim }, { text: s.filter, style: A.accent }, { text: "  ", style: A.dim });
  right.push({ text: count + range, style: A.dim });
  return leftRight([{ text: " drip ", style: A.pill }, { text: " " + host, style: A.dim }], right, width);
}

const STATUS_ICON: Record<StatusKind, Span | undefined> = {
  ok: { text: "✓ ", style: A.ok },
  err: { text: "✗ ", style: A.err },
  warn: { text: "! ", style: A.warn },
  busy: { text: "… ", style: A.accent },
  info: undefined,
};

/** A prompt label, the tail of the input (that's where typing happens), then a cursor block. */
function promptSpans(label: string, input: string, width: number): Span[] {
  const room = width - len(label) - 1;
  const cps = [...input];
  const shown = room <= 1 || cps.length <= room ? input : "…" + cps.slice(cps.length - room + 1).join("");
  return [{ text: label, style: A.key }, { text: shown }, { text: " ", style: A.cursor }];
}

function statusSpans(s: State, selected: FileListItem | undefined, width: number): Span[] {
  if (s.mode === "filter") return promptSpans(" / ", s.input, width);
  if (s.mode === "path-prompt") return promptSpans(" save to ", s.input, width);
  if (s.mode === "confirm-delete") {
    return [
      { text: " delete ", style: A.err },
      { text: selected?.filename ?? "?", style: A.errText },
      { text: "? ", style: A.errText },
      { text: "y", style: A.bold },
      { text: "/N", style: A.dim },
    ];
  }
  if (!s.status) return [];
  const icon = STATUS_ICON[s.statusKind];
  const msgStyle = s.statusKind === "err" ? A.errText : s.statusKind === "info" || s.statusKind === "busy" ? A.dim : undefined;
  return [{ text: " " }, ...(icon ? [icon] : []), { text: s.status, style: msgStyle }];
}

// [key, label] in display order; PRIORITY lists which survive on a narrow terminal.
const HINTS: Record<State["mode"], { hints: [string, string][]; priority: number[] }> = {
  list: {
    hints: [["↑↓", "move"], ["⏎", "url"], ["c", "copy"], ["s", "save"], ["S", "save as"], ["d", "delete"], ["/", "filter"], ["r", "refresh"], ["q", "quit"]],
    priority: [1, 2, 3, 8, 6, 5, 4, 7, 0],
  },
  filter: { hints: [["⏎", "keep"], ["^U", "erase"], ["esc", "clear"]], priority: [0, 2, 1] },
  "path-prompt": { hints: [["⏎", "save"], ["^U", "clear"], ["esc", "cancel"], ["~/", "home"]], priority: [0, 2, 1, 3] },
  "confirm-delete": { hints: [["y", "delete"], ["any key", "cancel"]], priority: [0, 1] },
};

function footer(mode: State["mode"], width: number): Span[] {
  const { hints, priority } = HINTS[mode];
  const cost = (i: number) => len(hints[i]![0]) + 1 + len(hints[i]![1]) + 2;
  const keep = new Set<number>();
  let used = 1;
  for (const i of priority) {
    if (used + cost(i) - 2 > width) break;
    keep.add(i);
    used += cost(i);
  }
  const spans: Span[] = [{ text: " " }];
  hints.forEach(([k, label], i) => {
    if (!keep.has(i)) return;
    if (spans.length > 1) spans.push({ text: "  " });
    spans.push({ text: k, style: A.key }, { text: " " + label, style: A.dim });
  });
  return spans;
}

// ---- details pane ----------------------------------------------------------

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function chunk(text: string, width: number): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += width) out.push(cps.slice(i, i + width).join(""));
  return out.length ? out : [""];
}

const LABEL_W = 9;

function details(it: FileListItem | undefined, width: number, now: number): Span[][] {
  const lines: Span[][] = [[{ text: "DETAILS", style: A.key }]];
  if (!it) return [...lines, [], [{ text: "nothing selected", style: A.dim }]];
  const valueW = Math.max(1, width - LABEL_W);
  const field = (label: string, value: string, style?: string) =>
    chunk(value, valueW).forEach((c, i) =>
      lines.push([{ text: (i === 0 ? label : "").padEnd(LABEL_W), style: A.dim }, { text: c, style }]));
  const created = Date.parse(it.created_at);
  const expires = Date.parse(it.expires_at);
  lines.push([]);
  field("name", it.filename, typeStyle(it.content_type));
  field("type", it.content_type);
  field("size", `${humanSize(it.size)} (${it.size.toLocaleString("en-US")} bytes)`);
  field("created", `${stamp(created)} · ${humanAge(now - created)} ago`);
  field("expires", `${stamp(expires)} · in ${humanAge(expires - now)}`, expiryStyle(expires - now));
  field("id", it.id, A.dim);
  lines.push([]);
  field("url", it.url, A.accent);
  return lines;
}

// ---- frame -----------------------------------------------------------------

export function render(s: State, cols: number, rows: number, now: number, host: string, color = true): string[] {
  const width = Math.max(1, cols);
  const height = listHeight(rows);
  const compact = rows < COMPACT_BELOW;
  const visible = visibleItems(s);
  const selected = visible[s.selected];

  const pane = width >= PANE_MIN_COLS;
  const paneW = pane ? Math.min(56, Math.floor(width * 0.4)) : 0;
  const listW = pane ? width - paneW - 2 : width;
  const paneLines = pane ? details(selected, paneW, now) : [];

  const rule = (joint: string) => {
    const r = "─".repeat(width);
    return paint([{ text: pane ? r.slice(0, listW) + joint + r.slice(listW + 1) : r, style: A.dim }], width, color);
  };

  // Body rows: optional column labels, then the list. The pane runs alongside all of them.
  const body: string[] = [];
  if (!compact) body.push(paint(LABELS, listW, color, { pad: pane }));
  for (let i = 0; i < height; i++) {
    const idx = s.scroll + i;
    const it = visible[idx];
    if (it) {
      const sel = idx === s.selected;
      body.push(paint(rowSpans(it, sel, now), listW, color, sel ? { bg: A.selBg } : { pad: pane }));
      continue;
    }
    const empty = s.loading ? "loading…" : s.filter ? "no matches" : "no drips yet — drip <file> to add one";
    const msg: Span[] = i === 0 && visible.length === 0 ? [{ text: "  " + empty, style: A.dim }] : [];
    body.push(paint(msg, listW, color, { pad: pane }));
  }
  const withPane = pane
    ? body.map((l, i) => l + paint([{ text: "│", style: A.dim }, { text: " " }], 2, color) + paint(paneLines[i] ?? [], paneW, color))
    : body;

  const lines = [paint(header(s, visible.length, height, host, width), width, color)];
  if (!compact) lines.push(rule("┬"));
  lines.push(...withPane);
  if (!compact) lines.push(rule("┴"));
  lines.push(paint(statusSpans(s, selected, width), width, color));
  lines.push(paint(footer(s.mode, width), width, color));
  return lines.slice(0, Math.max(rows, 0));
}

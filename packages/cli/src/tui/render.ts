import type { FileListItem } from "@drip/shared";
import { humanAge, humanSize } from "../format.js";
import { contentKind } from "./kind.js";
import { qrLines } from "./qr.js";
import { layout, TTLS, type Line, type State, type StatusKind } from "./state.js";

// ---- styling ---------------------------------------------------------------
//
// Spans name colour roles; a palette turns roles into SGR codes. "truecolor" is the
// tuned dark palette, "ansi16" maps the same roles onto the terminal's own 16 colours
// (so it follows the theme), "none" keeps attributes only (NO_COLOR, TERM=dumb).

export type Role =
  | "fg" | "dim" | "faint" | "sel" | "flash" | "chip" | "ink"
  | "aqua" | "lilac" | "mint" | "amber" | "coral" | "qr";
export type ColorMode = "truecolor" | "ansi16" | "none";

export interface Span { text: string; fg?: Role; bg?: Role; bold?: boolean; rev?: boolean }

export interface Look {
  color: ColorMode;
  /** Nerd Font glyphs; off means plain Unicode stand-ins. */
  icons: boolean;
  /** Spinners, the refresh reveal and the copy flash. */
  animations: boolean;
}

export const DEFAULT_LOOK: Look = { color: "truecolor", icons: true, animations: true };

const off = (v: string | undefined) => !!v && /^(0|false|no|off)$/i.test(v);

/**
 * NO_COLOR / TERM=dumb → no colour; DRIP_PALETTE=truecolor|ansi forces a palette, otherwise
 * truecolor when COLORTERM says so. DRIP_ICONS=0 drops the Nerd Font glyphs, DRIP_ANIMATIONS=0 the motion.
 */
export function lookFromEnv(env: Record<string, string | undefined>): Look {
  const dumb = env.TERM === "dumb";
  const palette = env.DRIP_PALETTE?.toLowerCase();
  const color: ColorMode = env.NO_COLOR || dumb ? "none"
    : palette === "truecolor" ? "truecolor"
    : palette === "ansi" || palette === "ansi16" || palette === "16" ? "ansi16"
    : /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") ? "truecolor" : "ansi16";
  return { color, icons: !dumb && !off(env.DRIP_ICONS), animations: !off(env.DRIP_ANIMATIONS) };
}

const RGB: Record<Role, string> = {
  fg: "225;233;237", dim: "127;143;154", faint: "47;63;75", sel: "10;39;55", flash: "0;78;93",
  chip: "17;33;44", ink: "5;19;29", aqua: "80;217;239", lilac: "200;174;250", mint: "120;220;169",
  amber: "237;187;100", coral: "249;119;112", qr: "232;240;244",
};

type Codes = Partial<Record<Role, string>>;
const PALETTES: Record<ColorMode, { fg: Codes; bg: Codes }> = {
  truecolor: {
    // Plain text keeps the terminal's own foreground.
    fg: Object.fromEntries(Object.entries(RGB).filter(([r]) => r !== "fg").map(([r, v]) => [r, `38;2;${v}`])),
    bg: Object.fromEntries(Object.entries(RGB).map(([r, v]) => [r, `48;2;${v}`])),
  },
  ansi16: {
    fg: { dim: "2", faint: "90", ink: "30", aqua: "36", lilac: "35", mint: "32", amber: "33", coral: "31", qr: "97" },
    bg: { sel: "100", flash: "46", chip: "100", ink: "40", aqua: "46", fg: "47" },
  },
  none: {
    fg: { dim: "2", faint: "2" },
    bg: { sel: "7", flash: "7", aqua: "7", fg: "7" },
  },
};

function sgr(sp: Span, lineBg: Role | undefined, mode: ColorMode): string {
  const p = PALETTES[mode];
  const bg = sp.bg ?? lineBg;
  return [sp.bold && "1", sp.rev && "7", sp.fg && p.fg[sp.fg], bg && p.bg[bg]].filter(Boolean).join(";");
}

const len = (t: string) => [...t].length;
const spansLen = (spans: Span[]) => spans.reduce((n, sp) => n + len(sp.text), 0);

/**
 * Lay spans into at most `width` columns, ending with "…" when they overflow.
 * With `bg`, every span without its own background gets it and the line is padded to `width`.
 */
export function paint(spans: Span[], width: number, mode: ColorMode, opts: { bg?: Role; pad?: boolean } = {}): string {
  if (width <= 0) return "";
  const total = spansLen(spans);
  const overflow = total > width;
  let left = overflow ? width - 1 : width;
  const pieces: Span[] = [];
  for (const sp of spans) {
    if (left <= 0) break;
    const take = [...sp.text].slice(0, left);
    if (take.length) pieces.push({ ...sp, text: take.join("") });
    left -= take.length;
  }
  if (overflow) pieces.push({ ...pieces.at(-1), text: "…" });
  const used = overflow ? width : total;
  if ((opts.bg || opts.pad) && used < width) pieces.push({ text: " ".repeat(width - used) });
  return pieces
    .map((p) => {
      const code = sgr(p, opts.bg, mode);
      return code ? `\x1b[${code}m${p.text}\x1b[0m` : p.text;
    })
    .join("");
}

/** Left spans, then right spans flush right — or left alone when both don't fit. */
function leftRight(left: Span[], right: Span[], width: number): Span[] {
  const gap = width - spansLen(left) - spansLen(right);
  return gap >= 1 ? [...left, { text: " ".repeat(gap) }, ...right] : left;
}

// ---- glyphs ----------------------------------------------------------------

const NF = {
  capL: "", capR: "", drop: "", server: "", search: "", folder: "",
  hourglass: "", link: "", qr: "", trash: "",
};
const IMG = "", TXT = "", FILE = "", CODE = "", ARCHIVE = "";
const FILE_ICON: Record<string, string> = {
  png: IMG, jpg: IMG, jpeg: IMG, gif: IMG, webp: IMG, svg: IMG, bmp: IMG, heic: IMG, avif: IMG,
  json: "", sql: "", md: "", txt: TXT, log: "", pdf: "", csv: "",
  zip: ARCHIVE, gz: ARCHIVE, tgz: ARCHIVE, tar: ARCHIVE, xz: ARCHIVE, "7z": ARCHIVE,
  mp4: "", mov: "", webm: "", mkv: "", mp3: "", wav: "", flac: "", m4a: "",
  js: CODE, ts: CODE, py: CODE, sh: CODE, go: CODE, rs: CODE, html: CODE, css: CODE, yaml: CODE, yml: CODE, toml: CODE, xml: CODE,
};

/** Refresh spinner (a drop falling and landing) and the copy splash. */
const DROP = ["⠁", "⠂", "⠄", "⡀", "⣀", "◡", "◠"];
const SPLASH = ["·", "•", "●", "✺", "⁂", "⁘"];

function fileIcon(it: FileListItem): string {
  const dot = it.filename.lastIndexOf(".");
  const ext = dot > 0 ? it.filename.slice(dot + 1).toLowerCase() : "";
  const k = contentKind(it.content_type);
  return FILE_ICON[ext] ?? (k === "image" ? IMG : k === "text" ? TXT : FILE);
}

const nf = (look: Look, glyph: string, plain = "") => (look.icons ? glyph : plain);
const spinner = (s: State, look: Look) => (look.animations ? DROP[s.tick % DROP.length]! : "…");

// ---- layout ----------------------------------------------------------------

/** Below this height the rules and column labels are dropped to keep rows for the list. */
const COMPACT_BELOW = 12;
const PANE_MIN_COLS = 110;

/** Rows available for the list. */
export function listHeight(rows: number): number {
  return Math.max(1, rows - (rows < COMPACT_BELOW ? 3 : 6));
}

const H = 3600_000;
const kindRole = (ct: string): Role => {
  const k = contentKind(ct);
  return k === "image" ? "lilac" : k === "text" ? "mint" : "fg";
};
const expiryRole = (ms: number): Role => (ms < H ? "coral" : ms < 6 * H ? "amber" : "dim");

function nameSpans(it: FileListItem): Span[] {
  const dot = it.filename.lastIndexOf(".");
  const fg = kindRole(it.content_type);
  if (dot <= 0) return [{ text: it.filename, fg }];
  return [{ text: it.filename.slice(0, dot), fg }, { text: it.filename.slice(dot), fg: "dim" }];
}

const COLS = { age: 4, size: 9, expires: 7 };

function rowSpans(it: FileListItem, selected: boolean, now: number, look: Look): Span[] {
  const expiresIn = Date.parse(it.expires_at) - now;
  const hourglass = expiresIn < 6 * H ? nf(look, NF.hourglass + " ") : "";
  return [
    { text: selected ? "▌ " : "  ", fg: "aqua" },
    ...(look.icons ? [{ text: fileIcon(it) + " ", fg: kindRole(it.content_type) }] : []),
    { text: " " + humanAge(now - Date.parse(it.created_at)).padStart(COLS.age), fg: "dim" },
    { text: "  " + humanSize(it.size).padStart(COLS.size) },
    { text: "  " + (hourglass + humanAge(expiresIn)).padStart(COLS.expires) + "  ", fg: expiryRole(expiresIn), bold: expiresIn < H },
    ...nameSpans(it),
  ];
}

const labels = (look: Look): Span[] => [{
  text: (look.icons ? "    " : "  ") + " " + "AGE".padStart(COLS.age) + "  " + "SIZE".padStart(COLS.size) +
    "  " + "EXPIRES".padStart(COLS.expires) + "  NAME",
  fg: "dim",
}];

function groupSpans(g: Extract<Line, { kind: "group" }>, width: number): Span[] {
  const head: Span[] = [{ text: `  ▾ ${g.label.toUpperCase()}`, fg: "aqua", bold: true }, { text: ` ${g.count} `, fg: "dim" }];
  return [...head, { text: "─".repeat(Math.max(0, width - spansLen(head))), fg: "faint" }];
}

/** Dim everything to the faint colour: a row mid-reveal. */
const ghost = (spans: Span[]): Span[] => spans.map((sp) => ({ text: sp.text, fg: "faint" }));

function header(s: State, visible: number, host: string, look: Look, width: number): Span[] {
  const drop = s.loading ? spinner(s, look) : NF.drop;
  const pill: Span[] = look.icons
    ? [{ text: NF.capL, fg: "aqua" }, { text: `${drop} drip`, fg: "ink", bg: "aqua", bold: true }, { text: NF.capR, fg: "aqua" }]
    : [{ text: " drip ", fg: "ink", bg: "aqua", bold: true }];
  const [dot, net]: [Role, string] = s.online === undefined ? ["dim", "connecting"] : s.online ? ["mint", "tailnet"] : ["coral", "offline"];
  const left: Span[] = [
    ...pill,
    { text: `  ${nf(look, NF.server + " ")}${host}  `, fg: "dim" },
    { text: "●", fg: dot },
    { text: " " + net, fg: "dim" },
  ];

  const right: Span[] = [];
  if (s.filter) right.push({ text: nf(look, NF.search + " ", "/ "), fg: "dim" }, { text: s.filter, fg: "aqua" }, { text: "   " });
  right.push({ text: nf(look, NF.folder + " ") + (s.grouping === "none" ? "flat" : `by ${s.grouping}`) + "   ", fg: "dim" });
  right.push({ text: s.filter ? `${visible}/${s.items.length} drips` : `${s.items.length} drips` });
  right.push({ text: ` · ${humanSize(s.items.reduce((n, it) => n + it.size, 0))}`, fg: "dim" });
  return leftRight(left, right, width);
}

// ---- status + footer -------------------------------------------------------

const STATUS: Record<Exclude<StatusKind, "busy">, { icon: string; icon_fg: Role; text_fg?: Role }> = {
  ok: { icon: "✓", icon_fg: "mint" },
  warn: { icon: "!", icon_fg: "amber" },
  err: { icon: "✗", icon_fg: "coral", text_fg: "coral" },
  info: { icon: "·", icon_fg: "dim", text_fg: "dim" },
};

/** A prompt label, the tail of the input (that's where typing happens), then a cursor block. */
function promptSpans(label: string, input: string, width: number): Span[] {
  const room = width - len(label) - 1;
  const cps = [...input];
  const shown = room <= 1 || cps.length <= room ? input : "…" + cps.slice(cps.length - room + 1).join("");
  return [{ text: label, fg: "aqua", bold: true }, { text: shown }, { text: " ", rev: true }];
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Shorten to `room` columns with a trailing "…". */
function clip(text: string, room: number): string {
  const cps = [...text];
  if (cps.length <= room) return text;
  return room <= 1 ? "" : cps.slice(0, room - 1).join("") + "…";
}

function ttlSpans(s: State, item: FileListItem | undefined, now: number, look: Look, width: number): Span[] {
  const [label, ms] = TTLS[s.ttlIdx]!;
  const chips: Span[] = TTLS.flatMap(([l], i): Span[] => [
    i === s.ttlIdx ? { text: ` ${l} `, fg: "ink", bg: "aqua", bold: true } : { text: ` ${l} `, bg: "chip" },
    { text: " " },
  ]);
  const head: Span = { text: ` ${nf(look, NF.hourglass + " ")}keep `, fg: "aqua", bold: true };
  const tail: Span = { text: ` → expires ${stamp(now + ms)} · in ${label}`, fg: "dim" };
  const room = width - spansLen([head, ...chips, tail]) - len(" for  ");
  const name = clip(item?.filename ?? "", room);
  return [head, ...(name ? [{ text: name }, { text: " for  ", fg: "dim" as Role }] : [{ text: "for  ", fg: "dim" as Role }]), ...chips, tail];
}

function statusSpans(s: State, selected: FileListItem | undefined, host: string, now: number, look: Look, width: number): Span[] {
  if (s.mode === "filter") return promptSpans(" / ", s.input, width);
  if (s.mode === "path-prompt") return promptSpans(" save to ", s.input, width);
  if (s.mode === "ttl") return ttlSpans(s, selected, now, look, width);
  if (s.mode === "confirm-delete") {
    return [
      { text: ` ${nf(look, NF.trash + " ")}delete `, fg: "coral", bold: true },
      { text: (selected?.filename ?? "?") + "? ", fg: "coral" },
      { text: "y", bold: true },
      { text: "/N", fg: "dim" },
    ];
  }
  if (s.loading) return [{ text: ` ${spinner(s, look)} `, fg: "aqua" }, { text: `dripping in from ${host}…`, fg: "dim" }];
  if (!s.status) return [];
  if (s.statusKind === "busy") return [{ text: ` ${spinner(s, look)} `, fg: "aqua" }, { text: s.status, fg: "dim" }];
  const st = STATUS[s.statusKind];
  // The copy splash plays in the icon slot, then settles on the tick.
  const splash = s.anim?.kind === "copy" && look.animations;
  const icon: Span = splash ? { text: ` ${SPLASH[Math.min(s.anim!.frame, SPLASH.length - 1)]} `, fg: "aqua" } : { text: ` ${st.icon} `, fg: st.icon_fg };
  return [icon, { text: s.status, fg: st.text_fg }];
}

// [key, label] in display order; PRIORITY lists which survive on a narrow terminal.
const HINTS: Record<State["mode"], { hints: [string, string][]; priority: number[] }> = {
  list: {
    hints: [["↑↓", "move"], ["⏎", "url"], ["c", "copy"], ["s", "save"], ["S", "save as"], ["t", "ttl"], ["d", "delete"],
      ["/", "filter"], ["⇥", "group"], ["r", "refresh"], ["q", "quit"]],
    priority: [1, 2, 3, 10, 7, 6, 5, 4, 8, 9, 0],
  },
  filter: { hints: [["⏎", "keep"], ["^U", "erase"], ["esc", "clear"]], priority: [0, 2, 1] },
  "path-prompt": { hints: [["⏎", "save"], ["^U", "clear"], ["esc", "cancel"], ["~/", "home"]], priority: [0, 2, 1, 3] },
  "confirm-delete": { hints: [["y", "delete"], ["any key", "cancel"]], priority: [0, 1] },
  ttl: { hints: [["←→", "pick"], [`1-${TTLS.length}`, "jump"], ["⏎", "set"], ["esc", "cancel"]], priority: [2, 0, 3, 1] },
};

function footer(mode: State["mode"], width: number): Span[] {
  const { hints, priority } = HINTS[mode];
  const cost = (i: number) => len(hints[i]![0]) + 2 + 1 + len(hints[i]![1]) + 2;
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
    spans.push({ text: ` ${k} `, fg: "aqua", bg: "chip", bold: true }, { text: " " + label, fg: "dim" });
  });
  return spans;
}

// ---- details pane ----------------------------------------------------------

function chunk(text: string, width: number): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += width) out.push(cps.slice(i, i + width).join(""));
  return out.length ? out : [""];
}

const LABEL_W = 9;

function details(s: State, it: FileListItem | undefined, width: number, height: number, now: number, look: Look): Span[][] {
  if (!it) return [[{ text: "nothing selected", fg: "dim" }]];
  const lines: Span[][] = [];
  const valueW = Math.max(1, width - LABEL_W);
  const field = (label: string, value: string, sp: Omit<Span, "text"> = {}) =>
    chunk(value, valueW).forEach((c, i) =>
      lines.push([{ text: (i === 0 ? label : "").padEnd(LABEL_W), fg: "dim" }, { text: c, ...sp }]));

  const fg = kindRole(it.content_type);
  const kind = contentKind(it.content_type);
  const created = Date.parse(it.created_at);
  const expires = Date.parse(it.expires_at);
  const flash = s.anim?.kind === "copy" && s.anim.frame < 5 && look.animations;

  const lead = look.icons ? fileIcon(it) + " " : "";
  chunk(it.filename, Math.max(1, width - len(lead))).forEach((c, i) =>
    lines.push([{ text: i === 0 ? lead : " ".repeat(len(lead)), fg }, { text: c, fg, bold: true }]));
  lines.push([{ text: `${kind} · dripped ${humanAge(now - created)} ago`, fg: "dim" }]);
  lines.push([]);
  field("type", it.content_type);
  field("size", `${humanSize(it.size)} (${it.size.toLocaleString("en-US")} bytes)`);
  field("created", `${stamp(created)} · ${humanAge(now - created)} ago`);
  field("expires", `${stamp(expires)} · in ${humanAge(expires - now)}`, { fg: expiryRole(expires - now) });
  const frac = Math.max(0, Math.min(1, (expires - now) / Math.max(expires - created, 1)));
  const barW = Math.max(4, Math.min(24, valueW - 10));
  const full = Math.round(frac * barW);
  field("ttl", "█".repeat(full) + "░".repeat(barW - full) + ` ${Math.round(frac * 100)}% left`, { fg: "dim" });
  field("id", it.id, { fg: "dim" });
  lines.push([]);
  field(nf(look, NF.link + " ") + "url", it.url, flash ? { bg: "flash" } : { fg: "aqua" });

  // The QR code only when it fits whole, with its caption.
  const qr = qrLines(it.url);
  if (lines.length + 2 + qr.length <= height && len(qr[0] ?? "") + 1 <= width) {
    lines.push([], [{ text: nf(look, NF.qr + " ") + "scan to fetch on another device", fg: "dim" }]);
    for (const row of qr) lines.push([{ text: " " }, { text: row, fg: "qr", bg: "ink" }]);
  }
  return lines;
}

// ---- frame -----------------------------------------------------------------

/** On a refresh, rows fade in top to bottom over the first frames: hidden, then faint, then whole. */
function revealOf(s: State, look: Look, pos: number, shown: number): "hidden" | "ghost" | "shown" {
  if (s.anim?.kind !== "refresh" || !look.animations) return "shown";
  const span = 12;
  const at = Math.floor((pos * span) / Math.max(span, shown));
  return s.anim.frame < at ? "hidden" : s.anim.frame === at ? "ghost" : "shown";
}

export function render(s: State, cols: number, rows: number, now: number, host: string, look: Look = DEFAULT_LOOK): string[] {
  const mode = look.color;
  const width = Math.max(1, cols);
  const height = listHeight(rows);
  const compact = rows < COMPACT_BELOW;
  const { order, lines: listLines } = layout(s);
  const selected = order[s.selected];

  const pane = width >= PANE_MIN_COLS;
  const paneW = pane ? Math.min(56, Math.floor(width * 0.4)) : 0;
  const listW = pane ? width - paneW - 2 : width;
  const bodyH = height + (compact ? 0 : 1);
  const paneLines = pane ? details(s, selected, paneW, bodyH, now, look) : [];
  const flash = s.anim?.kind === "copy" && s.anim.frame < 5 && look.animations;

  const rule = (joint: string) => {
    const r = "─".repeat(width);
    return paint([{ text: pane ? r.slice(0, listW) + joint + r.slice(listW + 1) : r, fg: "faint" }], width, mode);
  };

  // Body rows: optional column labels, then the list. The pane runs alongside all of them.
  const body: string[] = [];
  if (!compact) body.push(paint(labels(look), listW, mode, { pad: pane }));
  const shown = Math.min(height, listLines.length - s.scroll);
  for (let i = 0; i < height; i++) {
    const line = listLines[s.scroll + i];
    if (line) {
      const reveal = revealOf(s, look, i, shown);
      if (reveal === "hidden") { body.push(paint([], listW, mode, { pad: pane })); continue; }
      if (line.kind === "group") {
        const g = groupSpans(line, listW);
        body.push(paint(reveal === "ghost" ? ghost(g) : g, listW, mode, { pad: pane }));
        continue;
      }
      const sel = line.index === s.selected;
      const spans = rowSpans(line.item, sel, now, look);
      const bg: Role | undefined = sel ? (flash ? "flash" : "sel") : undefined;
      body.push(paint(reveal === "ghost" ? ghost(spans) : spans, listW, mode, bg ? { bg } : { pad: pane }));
      continue;
    }
    const empty = s.loading ? "" : s.filter ? "no matches" : "no drips yet — drip <file> to add one";
    const msg: Span[] = i === 0 && order.length === 0 && empty ? [{ text: "    " + empty, fg: "dim" }] : [];
    body.push(paint(msg, listW, mode, { pad: pane }));
  }
  const withPane = pane
    ? body.map((l, i) => l + paint([{ text: "│", fg: "faint" }, { text: " " }], 2, mode) + paint(paneLines[i] ?? [], paneW, mode))
    : body;

  const lines = [paint(header(s, order.length, host, look, width), width, mode)];
  if (!compact) lines.push(rule("┬"));
  lines.push(...withPane);
  if (!compact) lines.push(rule("┴"));
  lines.push(paint(statusSpans(s, selected, host, now, look, width), width, mode));
  lines.push(paint(footer(s.mode, width), width, mode));
  return lines.slice(0, Math.max(rows, 0));
}

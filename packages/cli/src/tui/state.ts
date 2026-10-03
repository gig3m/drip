import type { FileListItem } from "@drip/shared";
import type { Key } from "./term.js";
import { contentKind } from "./kind.js";

export type Mode = "list" | "filter" | "path-prompt" | "confirm-delete" | "ttl";
export type StatusKind = "info" | "ok" | "warn" | "err" | "busy";
export type Grouping = "time" | "type" | "none";
export type AnimKind = "refresh" | "copy";

export interface State {
  items: FileListItem[];
  /** Index into visibleItems(state): the flat, group-ordered list. */
  selected: number;
  /** First display line (group headers count) shown in the list. */
  scroll: number;
  filter: string;
  mode: Mode;
  /** Text being typed in filter / path-prompt mode. */
  input: string;
  status: string;
  statusKind: StatusKind;
  /** Bumped on every status change, so a fade timer can tell whether its message is still showing. */
  statusSeq: number;
  loading: boolean;
  grouping: Grouping;
  /** When the items were fetched; the time groups are cut against this, so they hold still between refreshes. */
  listedAt: number;
  /** Index into TTLS while choosing a new ttl. */
  ttlIdx: number;
  /** Whether the last request reached the server; undefined before the first one returns. */
  online?: boolean;
  /** A one-shot animation in progress. */
  anim: { kind: AnimKind; frame: number } | null;
  /** Free-running frame counter for spinners. */
  tick: number;
}

/** The ttl picker's choices, as the server's duration strings. */
export const TTLS: readonly [label: string, ms: number][] = [
  ["1h", 3600_000], ["6h", 6 * 3600_000], ["24h", 86_400_000], ["3d", 3 * 86_400_000], ["7d", 7 * 86_400_000],
];

export type Effect =
  | { kind: "copy-url"; item: FileListItem }
  | { kind: "copy-contents"; item: FileListItem }
  | { kind: "save"; item: FileListItem; path: string }
  | { kind: "delete"; item: FileListItem }
  | { kind: "set-ttl"; item: FileListItem; ttl: string }
  | { kind: "refresh" }
  | { kind: "quit" };

export interface Step { state: State; effect?: Effect }

export function initialState(): State {
  return {
    items: [], selected: 0, scroll: 0, filter: "", mode: "list", input: "", status: "", statusKind: "info",
    statusSeq: 0, loading: true, grouping: "time", listedAt: 0, ttlIdx: 2, anim: null, tick: 0,
  };
}

// ---- grouping --------------------------------------------------------------

export type Line =
  | { kind: "group"; label: string; count: number }
  | { kind: "item"; item: FileListItem; index: number };

const GROUP_KEYS: Record<Exclude<Grouping, "none">, string[]> = {
  time: ["last hour", "earlier today", "before today"],
  type: ["images", "text", "other"],
};

function groupOf(it: FileListItem, grouping: Grouping, listedAt: number): string {
  if (grouping === "type") {
    const k = contentKind(it.content_type);
    return k === "image" ? "images" : k === "text" ? "text" : "other";
  }
  const created = Date.parse(it.created_at);
  if (listedAt - created < 3600_000) return "last hour";
  return new Date(created).toDateString() === new Date(listedAt).toDateString() ? "earlier today" : "before today";
}

const matches = (s: State) => {
  const f = s.filter.toLowerCase();
  return f ? s.items.filter((it) => it.filename.toLowerCase().includes(f)) : s.items;
};

/** The list as displayed: group headers and items, plus the items alone in display order. */
export function layout(s: State): { order: FileListItem[]; lines: Line[] } {
  const vis = matches(s);
  if (s.grouping === "none") {
    return { order: vis, lines: vis.map((item, index) => ({ kind: "item", item, index })) };
  }
  const order: FileListItem[] = [];
  const lines: Line[] = [];
  for (const label of GROUP_KEYS[s.grouping]) {
    const group = vis.filter((it) => groupOf(it, s.grouping, s.listedAt) === label);
    if (!group.length) continue;
    lines.push({ kind: "group", label, count: group.length });
    for (const item of group) lines.push({ kind: "item", item, index: order.push(item) - 1 });
  }
  return { order, lines };
}

export function visibleItems(s: State): FileListItem[] {
  return layout(s).order;
}

export function selectedItem(s: State): FileListItem | undefined {
  return visibleItems(s)[s.selected];
}

/** A server-supplied filename made safe to use as a single path segment. */
export function safeName(filename: string): string {
  return filename.replace(/[/\\]/g, "_").replace(/^\.+/, "") || "download";
}

/** Clamp the selection and scroll the window so the selection (and its group header, at the top) is visible. */
export function fitView(s: State, height: number): State {
  const { order, lines } = layout(s);
  const selected = Math.max(0, Math.min(s.selected, order.length - 1));
  let scroll = Math.min(s.scroll, Math.max(0, lines.length - height));
  const at = lines.findIndex((l) => l.kind === "item" && l.index === selected);
  if (at >= 0) {
    if (at < scroll) scroll = lines[at - 1]?.kind === "group" ? at - 1 : at;
    if (at >= scroll + height) scroll = at - height + 1;
  }
  return { ...s, selected, scroll: Math.max(0, scroll) };
}

/** Re-select the item with `id` (if it is still visible) after the list changed shape. */
function keepSelection(s: State, id: string | undefined, height: number): State {
  const idx = id ? visibleItems(s).findIndex((it) => it.id === id) : -1;
  return fitView({ ...s, selected: idx >= 0 ? idx : s.selected }, height);
}

export function withItems(s: State, items: FileListItem[], height: number, now = Date.now()): State {
  return keepSelection({ ...s, items, loading: false, online: true, listedAt: now }, selectedItem(s)?.id, height);
}

export function replaceItem(s: State, item: FileListItem, height: number): State {
  const items = s.items.map((it) => (it.id === item.id ? item : it));
  return keepSelection({ ...s, items }, selectedItem(s)?.id, height);
}

export function removeItem(s: State, id: string, height: number): State {
  return fitView({ ...s, items: s.items.filter((it) => it.id !== id) }, height);
}

export function withStatus(s: State, status: string, kind: StatusKind = "info"): State {
  return { ...s, status, statusKind: kind, statusSeq: s.statusSeq + 1 };
}

/** Clear the status only if it is still the message with sequence `seq`. */
export function clearStatus(s: State, seq: number): State {
  return s.statusSeq === seq ? { ...s, status: "", statusKind: "info" } : s;
}

// ---- animation -------------------------------------------------------------

/** Frames per animation; one frame is FRAME_MS. */
export const FRAME_MS = 70;
export const ANIM_FRAMES: Record<AnimKind, number> = { refresh: 14, copy: 8 };

export function startAnim(s: State, kind: AnimKind): State {
  return { ...s, anim: { kind, frame: 0 } };
}

/** Whether anything on screen is moving, i.e. whether the app should keep ticking. */
export function animating(s: State): boolean {
  return !!s.anim || s.loading || s.statusKind === "busy";
}

export function advance(s: State): State {
  const tick = s.tick + 1;
  if (!s.anim) return { ...s, tick };
  const frame = s.anim.frame + 1;
  return { ...s, tick, anim: frame >= ANIM_FRAMES[s.anim.kind] ? null : { ...s.anim, frame } };
}

// ---- keys ------------------------------------------------------------------

export function reduce(s: State, key: Key, height: number): Step {
  if (key.name === "ctrl-c") return { state: s, effect: { kind: "quit" } };
  switch (s.mode) {
    case "filter": return reduceFilter(s, key, height);
    case "path-prompt": return reducePrompt(s, key);
    case "confirm-delete": return reduceConfirm(s, key);
    case "ttl": return reduceTtl(s, key);
    default: return reduceList(s, key, height);
  }
}

const move = (s: State, to: number, height: number): Step => ({ state: fitView({ ...s, selected: to }, height) });

const NEXT_GROUPING: Record<Grouping, Grouping> = { time: "type", type: "none", none: "time" };

function reduceList(s: State, key: Key, height: number): Step {
  const ch = key.name === "char" ? key.ch : undefined;
  if (key.name === "up" || ch === "k") return move(s, s.selected - 1, height);
  if (key.name === "down" || ch === "j") return move(s, s.selected + 1, height);
  if (key.name === "pageup") return move(s, s.selected - height, height);
  if (key.name === "pagedown") return move(s, s.selected + height, height);
  if (key.name === "home" || ch === "g") return move(s, 0, height);
  if (key.name === "end" || ch === "G") return move(s, visibleItems(s).length - 1, height);
  if (ch === "q") return { state: s, effect: { kind: "quit" } };
  if (key.name === "esc") {
    if (s.filter) return { state: fitView({ ...s, filter: "", selected: 0, scroll: 0, status: "" }, height) };
    return { state: s, effect: { kind: "quit" } };
  }
  if (ch === "r") return { state: s, effect: { kind: "refresh" } };
  if (ch === "/") return { state: { ...s, mode: "filter", input: s.filter } };
  if (key.name === "tab") {
    const grouping = NEXT_GROUPING[s.grouping];
    const next = keepSelection({ ...s, grouping, scroll: 0 }, selectedItem(s)?.id, height);
    return { state: withStatus(next, grouping === "none" ? "ungrouped" : `grouped by ${grouping}`) };
  }

  const isAction = key.name === "enter" || ch === "y" || ch === "c" || ch === "s" || ch === "S" || ch === "d" || ch === "t";
  if (!isAction) return { state: s };
  const item = selectedItem(s);
  if (!item) return { state: withStatus(s, "nothing selected", "warn") };
  if (key.name === "enter" || ch === "y") return { state: s, effect: { kind: "copy-url", item } };
  if (ch === "c") return { state: s, effect: { kind: "copy-contents", item } };
  if (ch === "s") return { state: s, effect: { kind: "save", item, path: `./${safeName(item.filename)}` } };
  if (ch === "S") return { state: { ...s, mode: "path-prompt", input: `./${safeName(item.filename)}`, status: "" } };
  if (ch === "t") {
    // Start on the shortest choice that doesn't shorten the drip's life.
    const left = Date.parse(item.expires_at) - s.listedAt;
    const idx = TTLS.findIndex(([, ms]) => ms >= left);
    return { state: { ...s, mode: "ttl", ttlIdx: idx < 0 ? TTLS.length - 1 : idx, status: "" } };
  }
  return { state: { ...s, mode: "confirm-delete", status: "" } };
}

function editInput(input: string, key: Key): string | undefined {
  if (key.name === "backspace") return [...input].slice(0, -1).join("");
  if (key.name === "ctrl-u") return "";
  if (key.name === "char") return input + key.ch;
  return undefined;
}

function reduceFilter(s: State, key: Key, height: number): Step {
  if (key.name === "enter") return { state: { ...s, mode: "list", input: "" } };
  if (key.name === "esc") {
    return { state: fitView({ ...s, mode: "list", input: "", filter: "", selected: 0, scroll: 0 }, height) };
  }
  const input = editInput(s.input, key);
  if (input === undefined) return { state: s };
  return { state: fitView({ ...s, input, filter: input, selected: 0, scroll: 0 }, height) };
}

function reducePrompt(s: State, key: Key): Step {
  if (key.name === "esc") return { state: withStatus({ ...s, mode: "list", input: "" }, "save cancelled") };
  if (key.name === "enter") {
    const item = selectedItem(s);
    const path = s.input.trim();
    const state: State = { ...s, mode: "list", input: "" };
    if (!item || !path) return { state: withStatus(state, "save cancelled") };
    return { state, effect: { kind: "save", item, path } };
  }
  const input = editInput(s.input, key);
  return { state: input === undefined ? s : { ...s, input } };
}

function reduceConfirm(s: State, key: Key): Step {
  const state: State = { ...s, mode: "list" };
  const item = selectedItem(s);
  if (key.name === "char" && (key.ch === "y" || key.ch === "Y") && item) {
    return { state, effect: { kind: "delete", item } };
  }
  return { state: withStatus(state, "delete cancelled") };
}

function reduceTtl(s: State, key: Key): Step {
  const ch = key.name === "char" ? key.ch : undefined;
  const pick = (i: number): Step => ({ state: { ...s, ttlIdx: Math.max(0, Math.min(TTLS.length - 1, i)) } });
  if (key.name === "left" || ch === "h") return pick(s.ttlIdx - 1);
  if (key.name === "right" || ch === "l") return pick(s.ttlIdx + 1);
  if (ch && /^[1-9]$/.test(ch) && Number(ch) <= TTLS.length) return pick(Number(ch) - 1);
  if (key.name === "enter") {
    const item = selectedItem(s);
    const state: State = { ...s, mode: "list" };
    if (!item) return { state: withStatus(state, "nothing selected", "warn") };
    return { state, effect: { kind: "set-ttl", item, ttl: TTLS[s.ttlIdx]![0] } };
  }
  if (key.name === "esc" || ch === "q") return { state: withStatus({ ...s, mode: "list" }, "ttl unchanged") };
  return { state: s };
}

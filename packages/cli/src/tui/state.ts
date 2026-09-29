import type { FileListItem } from "@drip/shared";
import type { Key } from "./term.js";

export type Mode = "list" | "filter" | "path-prompt" | "confirm-delete";
export type StatusKind = "info" | "ok" | "warn" | "err" | "busy";

export interface State {
  items: FileListItem[];
  /** Index into visibleItems(state). */
  selected: number;
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
}

export type Effect =
  | { kind: "copy-url"; item: FileListItem }
  | { kind: "copy-contents"; item: FileListItem }
  | { kind: "save"; item: FileListItem; path: string }
  | { kind: "delete"; item: FileListItem }
  | { kind: "refresh" }
  | { kind: "quit" };

export interface Step { state: State; effect?: Effect }

export function initialState(): State {
  return { items: [], selected: 0, scroll: 0, filter: "", mode: "list", input: "", status: "", statusKind: "info", statusSeq: 0, loading: true };
}

export function visibleItems(s: State): FileListItem[] {
  if (!s.filter) return s.items;
  const f = s.filter.toLowerCase();
  return s.items.filter((it) => it.filename.toLowerCase().includes(f));
}

export function selectedItem(s: State): FileListItem | undefined {
  return visibleItems(s)[s.selected];
}

/** A server-supplied filename made safe to use as a single path segment. */
export function safeName(filename: string): string {
  return filename.replace(/[/\\]/g, "_").replace(/^\.+/, "") || "download";
}

/** Clamp the selection and scroll the window so the selection is visible. */
export function fitView(s: State, height: number): State {
  const n = visibleItems(s).length;
  const selected = Math.max(0, Math.min(s.selected, n - 1));
  let scroll = Math.min(s.scroll, Math.max(0, n - height));
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + height) scroll = selected - height + 1;
  return { ...s, selected, scroll: Math.max(0, scroll) };
}

export function withItems(s: State, items: FileListItem[], height: number): State {
  const keepId = selectedItem(s)?.id;
  const next: State = { ...s, items, loading: false };
  const idx = keepId ? visibleItems(next).findIndex((it) => it.id === keepId) : -1;
  return fitView({ ...next, selected: idx >= 0 ? idx : s.selected }, height);
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

export function reduce(s: State, key: Key, height: number): Step {
  if (key.name === "ctrl-c") return { state: s, effect: { kind: "quit" } };
  switch (s.mode) {
    case "filter": return reduceFilter(s, key, height);
    case "path-prompt": return reducePrompt(s, key);
    case "confirm-delete": return reduceConfirm(s, key);
    default: return reduceList(s, key, height);
  }
}

const move = (s: State, to: number, height: number): Step => ({ state: fitView({ ...s, selected: to }, height) });

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

  const isAction = key.name === "enter" || ch === "y" || ch === "c" || ch === "s" || ch === "S" || ch === "d";
  if (!isAction) return { state: s };
  const item = selectedItem(s);
  if (!item) return { state: withStatus(s, "nothing selected", "warn") };
  if (key.name === "enter" || ch === "y") return { state: s, effect: { kind: "copy-url", item } };
  if (ch === "c") return { state: s, effect: { kind: "copy-contents", item } };
  if (ch === "s") return { state: s, effect: { kind: "save", item, path: `./${safeName(item.filename)}` } };
  if (ch === "S") return { state: { ...s, mode: "path-prompt", input: `./${safeName(item.filename)}`, status: "" } };
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

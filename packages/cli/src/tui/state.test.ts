import { describe, it, expect } from "vitest";
import type { FileListItem } from "@drip/shared";
import type { Key } from "./term.js";
import { initialState, reduce, withItems, removeItem, visibleItems, safeName, withStatus, clearStatus, type State, type Step } from "./state.js";

const item = (id: string, filename: string): FileListItem => ({
  id, filename, content_type: "image/png", url: `https://h/f/${id}/${filename}`, size: 10,
  created_at: "2026-09-22T00:00:00.000Z", expires_at: "2026-09-23T00:00:00.000Z",
});
const ch = (c: string): Key => ({ name: "char", ch: c });
const k = (name: Key["name"]): Key => ({ name });
const H = 3;
const loaded = (n = 5): State =>
  withItems(initialState(), Array.from({ length: n }, (_, i) => item(`id${i}`, `file${i}.png`)), H);

function press(s: State, ...keys: Key[]): Step {
  let step: Step = { state: s };
  for (const key of keys) step = reduce(step.state, key, H);
  return step;
}

describe("items", () => {
  it("withItems clears loading and keeps the selection by id across a refresh", () => {
    const s = press(loaded(), ch("j"), ch("j")).state;
    const refreshed = withItems(s, [item("new", "new.png"), ...s.items], H);
    expect(refreshed.loading).toBe(false);
    expect(visibleItems(refreshed)[refreshed.selected]!.id).toBe("id2");
  });
  it("removeItem clamps the selection when the last row goes", () => {
    const s = press(loaded(3), k("end")).state;
    const after = removeItem(s, "id2", H);
    expect(after.selected).toBe(1);
  });
});

describe("navigation", () => {
  it("j/k and arrows move and clamp", () => {
    expect(press(loaded(), k("up")).state.selected).toBe(0);
    expect(press(loaded(), ch("j"), k("down")).state.selected).toBe(2);
    expect(press(loaded(), ch("j"), ch("k")).state.selected).toBe(0);
    expect(press(loaded(), ...Array(9).fill(ch("j"))).state.selected).toBe(4);
  });
  it("scroll follows the selection", () => {
    const s = press(loaded(), ch("j"), ch("j"), ch("j"), ch("j")).state;
    expect(s.scroll).toBe(2);
    expect(press(s, ch("g")).state).toMatchObject({ selected: 0, scroll: 0 });
  });
  it("G, pagedown and pageup jump", () => {
    expect(press(loaded(), ch("G")).state.selected).toBe(4);
    expect(press(loaded(), k("pagedown")).state.selected).toBe(3);
    expect(press(loaded(), ch("G"), k("pageup")).state.selected).toBe(1);
  });
});

describe("actions", () => {
  it("enter and y copy the selected url", () => {
    expect(press(loaded(), ch("j"), k("enter")).effect).toEqual({ kind: "copy-url", item: item("id1", "file1.png") });
    expect(press(loaded(), ch("y")).effect?.kind).toBe("copy-url");
  });
  it("c copies contents, s saves to ./<safe name>", () => {
    expect(press(loaded(), ch("c")).effect?.kind).toBe("copy-contents");
    expect(press(loaded(), ch("s")).effect).toEqual({ kind: "save", item: item("id0", "file0.png"), path: "./file0.png" });
  });
  it("S opens an editable prompt and enter saves to the typed path", () => {
    const opened = press(loaded(), ch("S")).state;
    expect(opened).toMatchObject({ mode: "path-prompt", input: "./file0.png" });
    const step = press(opened, k("backspace"), k("backspace"), k("backspace"), ch("j"), ch("p"), ch("g"), k("enter"));
    expect(step.effect).toEqual({ kind: "save", item: item("id0", "file0.png"), path: "./file0.jpg" });
    expect(step.state.mode).toBe("list");
  });
  it("ctrl-u clears the prompt so a different directory can be typed", () => {
    const step = press(loaded(), ch("S"), k("ctrl-u"), ...[..."~/x.png"].map(ch), k("enter"));
    expect(step.effect).toMatchObject({ kind: "save", path: "~/x.png" });
  });
  it("esc cancels the prompt without an effect", () => {
    const step = press(loaded(), ch("S"), k("esc"));
    expect(step.effect).toBeUndefined();
    expect(step.state).toMatchObject({ mode: "list", status: "save cancelled" });
  });
  it("d then y deletes; d then anything else cancels", () => {
    expect(press(loaded(), ch("d"), ch("y")).effect).toEqual({ kind: "delete", item: item("id0", "file0.png") });
    const cancelled = press(loaded(), ch("d"), ch("n"));
    expect(cancelled.effect).toBeUndefined();
    expect(cancelled.state).toMatchObject({ mode: "list", status: "delete cancelled" });
  });
  it("r refreshes", () => {
    expect(press(loaded(), ch("r")).effect).toEqual({ kind: "refresh" });
  });
  it("actions on an empty list only set a status", () => {
    const step = press(withItems(initialState(), [], H), ch("y"));
    expect(step.effect).toBeUndefined();
    expect(step.state.status).toBe("nothing selected");
  });
});

describe("filter", () => {
  const mixed = () => withItems(initialState(), [item("a", "Shot.png"), item("b", "notes.txt"), item("c", "shot-2.png")], H);
  it("filters case-insensitively as you type and resets the selection", () => {
    const s = press(mixed(), ch("j"), ch("/"), ch("s"), ch("h")).state;
    expect(visibleItems(s).map((i) => i.id)).toEqual(["a", "c"]);
    expect(s.selected).toBe(0);
  });
  it("enter keeps the filter, esc in the list clears it", () => {
    const kept = press(mixed(), ch("/"), ch("t"), ch("x"), k("enter")).state;
    expect(kept).toMatchObject({ mode: "list", filter: "tx" });
    expect(press(kept, k("esc")).state.filter).toBe("");
    expect(press(kept, k("esc")).effect).toBeUndefined();
  });
  it("esc while typing clears the filter", () => {
    expect(press(mixed(), ch("/"), ch("z"), k("esc")).state).toMatchObject({ mode: "list", filter: "" });
  });
  it("actions apply to the filtered selection", () => {
    expect(press(mixed(), ch("/"), ch("t"), ch("x"), k("enter"), ch("y")).effect).toMatchObject({ item: { id: "b" } });
  });
});

describe("quit", () => {
  it("q and esc quit from the list, ctrl-c from any mode", () => {
    expect(press(loaded(), ch("q")).effect).toEqual({ kind: "quit" });
    expect(press(loaded(), k("esc")).effect).toEqual({ kind: "quit" });
    expect(press(loaded(), ch("S"), k("ctrl-c")).effect).toEqual({ kind: "quit" });
  });
  it("q typed into the prompt is text, not quit", () => {
    const step = press(loaded(), ch("S"), ch("q"));
    expect(step.effect).toBeUndefined();
    expect(step.state.input).toBe("./file0.pngq");
  });
});

describe("safeName", () => {
  it("neutralises path separators and leading dots", () => {
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeName(".bashrc")).toBe("bashrc");
    expect(safeName("")).toBe("download");
  });
});

describe("status", () => {
  it("withStatus records a kind and bumps the sequence", () => {
    const s = withStatus(loaded(), "copied url", "ok");
    expect(s).toMatchObject({ status: "copied url", statusKind: "ok" });
    expect(withStatus(s, "x").statusSeq).toBe(s.statusSeq + 1);
  });
  it("clearStatus only clears the message it was scheduled for", () => {
    const s = withStatus(loaded(), "copied url", "ok");
    expect(clearStatus(s, s.statusSeq)).toMatchObject({ status: "", statusKind: "info" });
    const newer = withStatus(s, "saved", "ok");
    expect(clearStatus(newer, s.statusSeq).status).toBe("saved");
  });
  it("an action on an empty list is a warning", () => {
    expect(press(withItems(initialState(), [], H), ch("y")).state.statusKind).toBe("warn");
  });
});

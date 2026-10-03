import { describe, it, expect } from "vitest";
import type { FileListItem } from "@drip/shared";
import type { Key } from "./term.js";
import {
  advance, animating, ANIM_FRAMES, clearStatus, initialState, layout, reduce, removeItem, replaceItem, safeName,
  startAnim, TTLS, visibleItems, withItems, withStatus, type State, type Step,
} from "./state.js";

const item = (id: string, filename: string, o: Partial<FileListItem> = {}): FileListItem => ({
  id, filename, content_type: "image/png", url: `https://h/f/${id}/${filename}`, size: 10,
  created_at: "2026-09-22T00:00:00.000Z", expires_at: "2026-09-23T00:00:00.000Z", ...o,
});
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const ch = (c: string): Key => ({ name: "char", ch: c });
const k = (name: Key["name"]): Key => ({ name });
const H = 3;
/** Flat (ungrouped), so selection index == display line. */
const loaded = (n = 5): State =>
  ({ ...withItems(initialState(), Array.from({ length: n }, (_, i) => item(`id${i}`, `file${i}.png`)), H, NOW), grouping: "none" });

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

describe("grouping", () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const mixed = () => withItems(initialState(), [
    item("t1", "a.txt", { content_type: "text/plain", created_at: ago(60_000) }),
    item("i1", "b.png", { created_at: ago(2 * 3600_000) }),
    item("o1", "c.pdf", { content_type: "application/pdf", created_at: ago(30 * 3600_000) }),
    item("i2", "d.png", { created_at: ago(5 * 60_000) }),
  ], 10, NOW);

  it("groups by time by default, newest group first, items keep server order inside a group", () => {
    const { order, lines } = layout(mixed());
    expect(lines.map((l) => (l.kind === "group" ? `[${l.label} ${l.count}]` : l.item.id))).toEqual(
      ["[last hour 2]", "t1", "i2", "[earlier today 1]", "i1", "[before today 1]", "o1"]);
    expect(order.map((it) => it.id)).toEqual(["t1", "i2", "i1", "o1"]);
  });

  it("cuts the time groups against when the list was fetched, not the wall clock", () => {
    const later = { ...mixed(), listedAt: NOW + 3 * 86_400_000 };
    expect(layout(later).lines.filter((l) => l.kind === "group").map((l) => l.kind === "group" && l.label)).toEqual(["before today"]);
  });

  it("tab cycles time → type → none → time, keeping the selected drip", () => {
    let s = press(mixed(), ch("j"), ch("j")).state; // i1
    s = press(s, k("tab")).state;
    expect(s).toMatchObject({ grouping: "type", status: "grouped by type" });
    expect(layout(s).lines.map((l) => (l.kind === "group" ? l.label : l.item.id))).toEqual(["images", "i1", "i2", "text", "t1", "other", "o1"]);
    expect(visibleItems(s)[s.selected]!.id).toBe("i1");
    s = press(s, k("tab")).state;
    expect(s).toMatchObject({ grouping: "none", status: "ungrouped" });
    expect(visibleItems(s)[s.selected]!.id).toBe("i1");
    expect(press(s, k("tab")).state.grouping).toBe("time");
  });

  it("filters within groups and drops empty ones", () => {
    const s = { ...mixed(), filter: ".png" };
    expect(layout(s).lines.map((l) => (l.kind === "group" ? l.label : l.item.id))).toEqual(["last hour", "i2", "earlier today", "i1"]);
  });

  it("scrolls by display line and shows a group's header when its first drip is at the top", () => {
    const go = (s: State, ...keys: Key[]) => keys.reduce((st, key) => reduce(st, key, 2).state, s);
    let s = go(mixed(), ch("j"), ch("j"), ch("j")); // o1: line 6
    expect(s.scroll).toBe(5);
    s = go(s, ch("k"), ch("k")); // i2: line 2; the line above is t1, not a header
    expect(s.scroll).toBe(2);
    expect(go(s, ch("k")).scroll).toBe(0); // t1 is first in its group: bring the header along
  });
});

describe("ttl", () => {
  const one = (left: number) => withItems(initialState(), [item("a", "a.png", { expires_at: new Date(NOW + left).toISOString() })], H, NOW);

  it("t opens the picker on the shortest choice that does not shorten the drip", () => {
    expect(press(one(23 * 3600_000), ch("t")).state).toMatchObject({ mode: "ttl", ttlIdx: 2 });
    expect(press(one(30 * 60_000), ch("t")).state.ttlIdx).toBe(0);
    expect(press(one(30 * 86_400_000), ch("t")).state.ttlIdx).toBe(TTLS.length - 1);
  });

  it("arrows, h/l and digits pick; enter sets; esc leaves it alone", () => {
    const s = press(one(3600_000), ch("t")).state;
    expect(press(s, k("right"), ch("l")).state.ttlIdx).toBe(2);
    expect(press(s, k("left"), ch("h")).state.ttlIdx).toBe(0);
    expect(press(s, ch("4")).state.ttlIdx).toBe(3);
    expect(press(s, ch("9")).state.ttlIdx).toBe(0);
    const set = press(s, ch("5"), k("enter"));
    expect(set.state.mode).toBe("list");
    expect(set.effect).toEqual({ kind: "set-ttl", item: s.items[0], ttl: "7d" });
    expect(press(s, k("esc")).state).toMatchObject({ mode: "list", status: "ttl unchanged" });
  });

  it("replaceItem swaps in the server's copy and keeps the selection", () => {
    const s = press(loaded(3), ch("j")).state;
    const next = replaceItem(s, { ...s.items[1]!, expires_at: "2027-01-01T00:00:00.000Z" }, H);
    expect(next.items[1]!.expires_at).toBe("2027-01-01T00:00:00.000Z");
    expect(next.selected).toBe(1);
  });
});

describe("animation", () => {
  it("advance runs a one-shot animation to its end, and always ticks the spinner", () => {
    let s = startAnim(loaded(), "copy");
    for (let i = 0; i < ANIM_FRAMES.copy - 1; i++) s = advance(s);
    expect(s.anim).toEqual({ kind: "copy", frame: ANIM_FRAMES.copy - 1 });
    s = advance(s);
    expect(s.anim).toBeNull();
    expect(s.tick).toBe(ANIM_FRAMES.copy);
  });
  it("is animating while loading, busy or mid-animation", () => {
    expect(animating(initialState())).toBe(true);
    expect(animating(loaded())).toBe(false);
    expect(animating(withStatus(loaded(), "working…", "busy"))).toBe(true);
    expect(animating(startAnim(loaded(), "refresh"))).toBe(true);
  });
});

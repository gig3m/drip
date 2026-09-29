import { describe, it, expect } from "vitest";
import { route } from "./args.js";

describe("route", () => {
  it("flags", () => {
    expect(route(["--help"]).kind).toBe("help");
    expect(route(["-h"]).kind).toBe("help");
    expect(route(["--version"]).kind).toBe("version");
    expect(route(["-v"]).kind).toBe("version");
    expect(route([])).toEqual({ kind: "tui", bare: true });
  });
  it("bare paths upload", () => {
    expect(route(["a.png"])).toEqual({ kind: "upload", files: ["a.png"] });
    expect(route(["a.png", "b.pdf"])).toEqual({ kind: "upload", files: ["a.png", "b.pdf"] });
  });
  it("subcommands", () => {
    expect(route(["clip"]).kind).toBe("clip");
    expect(route(["upgrade"]).kind).toBe("upgrade");
    expect(route(["send", "x", "y"])).toEqual({ kind: "upload", files: ["x", "y"] });
    expect(route(["send"]).kind).toBe("usage-error");
  });
  it("list options", () => {
    expect(route(["list"])).toEqual({ kind: "list", n: 20, json: false });
    expect(route(["list", "-n", "5"])).toEqual({ kind: "list", n: 5, json: false });
    expect(route(["list", "--json"])).toEqual({ kind: "list", n: 20, json: true });
  });
  it("get options", () => {
    expect(route(["get", "abc"])).toEqual({ kind: "get", target: "abc", out: undefined });
    expect(route(["get", "abc", "-o", "out.png"])).toEqual({ kind: "get", target: "abc", out: "out.png" });
    expect(route(["get", "abc", "-o", "-"])).toEqual({ kind: "get", target: "abc", out: "-" });
    expect(route(["get"]).kind).toBe("usage-error");
  });
  it("a path that looks like a subcommand name is uploaded when it contains a slash", () => {
    expect(route(["./list"])).toEqual({ kind: "upload", files: ["./list"] });
  });
  it("raycast install", () => {
    expect(route(["raycast"])).toEqual({ kind: "raycast", dir: undefined });
    expect(route(["raycast", "--dir", "/tmp/x"])).toEqual({ kind: "raycast", dir: "/tmp/x" });
  });
});

describe("tui", () => {
  it("routes tui and browse", () => {
    expect(route(["tui"])).toEqual({ kind: "tui", bare: false });
    expect(route(["browse"])).toEqual({ kind: "tui", bare: false });
  });
});

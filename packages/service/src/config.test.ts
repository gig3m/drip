import { describe, it, expect } from "vitest";
import { parseDuration, parseSize, loadConfig } from "./config.js";

describe("parseDuration", () => {
  it("parses units to ms", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });
  it("throws on garbage", () => {
    expect(() => parseDuration("nope")).toThrow();
  });
});

describe("parseSize", () => {
  it("parses units to bytes (case-insensitive)", () => {
    expect(parseSize("512b")).toBe(512);
    expect(parseSize("1kb")).toBe(1024);
    expect(parseSize("100MB")).toBe(104_857_600);
    expect(parseSize("1gb")).toBe(1_073_741_824);
  });
});

describe("loadConfig", () => {
  it("requires DRIP_BASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DRIP_BASE_URL/);
  });
  it("applies documented defaults", () => {
    const c = loadConfig({ DRIP_BASE_URL: "https://h" });
    expect(c).toMatchObject({
      baseUrl: "https://h", dataDir: "/data",
      defaultTtlMs: 86_400_000, maxTtlMs: 604_800_000,
      maxSizeBytes: 104_857_600, sweepIntervalMs: 60_000, port: 8787,
    });
    expect(c.token).toBeUndefined();
  });
  it("reads overrides including token", () => {
    const c = loadConfig({ DRIP_BASE_URL: "https://h", DRIP_TOKEN: "t", PORT: "9000", DRIP_DEFAULT_TTL: "1h" });
    expect(c.token).toBe("t");
    expect(c.port).toBe(9000);
    expect(c.defaultTtlMs).toBe(3_600_000);
  });
  it("throws on invalid PORT", () => {
    expect(() => loadConfig({ DRIP_BASE_URL: "https://h", PORT: "abc" })).toThrow(/PORT/);
  });
  it("treats empty DRIP_TOKEN as undefined", () => {
    const c = loadConfig({ DRIP_BASE_URL: "https://h", DRIP_TOKEN: "" });
    expect(c.token).toBeUndefined();
  });
  it("throws on malformed DRIP_BASE_URL", () => {
    expect(() => loadConfig({ DRIP_BASE_URL: "not a url" })).toThrow(/DRIP_BASE_URL/);
  });
});

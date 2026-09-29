import { describe, it, expect } from "vitest";
import { loadCliConfig } from "./config.js";

describe("loadCliConfig", () => {
  it("throws when neither env nor baked default is present", () => {
    expect(() => loadCliConfig({}, undefined)).toThrow(/DRIP_BASE_URL/);
  });
  it("reads base url and optional token from env", () => {
    expect(loadCliConfig({ DRIP_BASE_URL: "https://h", DRIP_TOKEN: "t" }, undefined)).toEqual({ baseUrl: "https://h", token: "t" });
  });
  it("falls back to the baked default when env is unset", () => {
    expect(loadCliConfig({}, "https://drip.example.com")).toEqual({ baseUrl: "https://drip.example.com", token: undefined });
  });
  it("env overrides the baked default", () => {
    expect(loadCliConfig({ DRIP_BASE_URL: "https://other" }, "https://drip.example.com").baseUrl).toBe("https://other");
  });
});

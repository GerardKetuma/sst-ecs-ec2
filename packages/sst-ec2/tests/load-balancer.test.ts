import { describe, it, expect } from "vitest";
import { parsePortString } from "../src/load-balancer.js";

describe("parsePortString", () => {
  it("parses 80/http", () => {
    expect(parsePortString("80/http")).toEqual({ port: 80, protocol: "http" });
  });
  it("parses 443/https", () => {
    expect(parsePortString("443/https")).toEqual({ port: 443, protocol: "https" });
  });
  it("throws on bad format", () => {
    expect(() => parsePortString("80")).toThrow();
    expect(() => parsePortString("abc/http")).toThrow();
    expect(() => parsePortString("80/tcp")).toThrow();
    expect(() => parsePortString("99999/http")).toThrow();
  });
});

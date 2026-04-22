import { describe, it, expect } from "vitest";
import {
  archToEcsToken,
  defaultInstanceType,
  normalizeArchitecture,
  normalizeCpu,
  normalizeMemory,
  normalizeNetworkMode,
  normalizeVariant,
} from "../src/normalize.js";

describe("normalizeArchitecture", () => {
  it("defaults to x86_64", () => {
    expect(normalizeArchitecture(undefined)).toBe("x86_64");
  });
  it("accepts arm64", () => {
    expect(normalizeArchitecture("arm64")).toBe("arm64");
  });
  it("rejects unknown arch", () => {
    expect(() => normalizeArchitecture("mips" as "x86_64")).toThrow();
  });
});

describe("normalizeNetworkMode", () => {
  it("defaults to awsvpc", () => {
    expect(normalizeNetworkMode(undefined)).toBe("awsvpc");
  });
  it("accepts bridge, host", () => {
    expect(normalizeNetworkMode("bridge")).toBe("bridge");
    expect(normalizeNetworkMode("host")).toBe("host");
  });
});

describe("normalizeVariant", () => {
  it("defaults to aws-ecs-2", () => {
    expect(normalizeVariant(undefined)).toBe("aws-ecs-2");
  });
  it("accepts aws-ecs-1", () => {
    expect(normalizeVariant("aws-ecs-1")).toBe("aws-ecs-1");
  });
});

describe("normalizeCpu / normalizeMemory", () => {
  it("accepts undefined", () => {
    expect(normalizeCpu(undefined)).toBeUndefined();
    expect(normalizeMemory(undefined)).toBeUndefined();
  });
  it("accepts positive integers", () => {
    expect(normalizeCpu(512)).toBe(512);
    expect(normalizeMemory(1024)).toBe(1024);
  });
  it("rejects zero / negative / non-integer", () => {
    expect(() => normalizeCpu(0)).toThrow();
    expect(() => normalizeCpu(-1)).toThrow();
    expect(() => normalizeCpu(1.5)).toThrow();
    expect(() => normalizeMemory(0)).toThrow();
  });
});

describe("defaults", () => {
  it("defaultInstanceType per arch", () => {
    expect(defaultInstanceType("x86_64")).toBe("t3.medium");
    expect(defaultInstanceType("arm64")).toBe("t4g.medium");
  });
  it("archToEcsToken", () => {
    expect(archToEcsToken("x86_64")).toBe("X86_64");
    expect(archToEcsToken("arm64")).toBe("ARM64");
  });
});

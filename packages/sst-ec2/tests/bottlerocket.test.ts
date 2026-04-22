import { describe, it, expect } from "vitest";
import TOML from "@iarna/toml";
import {
  buildBottlerocketSettings,
  encodeUserData,
  serializeBottlerocketToml,
} from "../src/bottlerocket.js";

describe("buildBottlerocketSettings", () => {
  it("produces a cluster-joining settings object with admin off and control on by default", () => {
    const s = buildBottlerocketSettings({
      clusterName: "Demo",
      enableAdminContainer: false,
    });
    expect(s.ecs.cluster).toBe("Demo");
    expect(s.ecs["enable-spot-instance-draining"]).toBe(true);
    expect(s["host-containers"].admin.enabled).toBe(false);
    expect(s["host-containers"].control.enabled).toBe(true);
    expect(s.kernel.sysctl["net.ipv4.ip_local_port_range"]).toBe("1024 65535");
  });

  it("enables admin container when flag is set", () => {
    const s = buildBottlerocketSettings({ clusterName: "X", enableAdminContainer: true });
    expect(s["host-containers"].admin.enabled).toBe(true);
    expect(s["host-containers"].admin.superpowered).toBe(true);
  });
});

describe("serializeBottlerocketToml", () => {
  it("produces valid TOML that round-trips", () => {
    const s = buildBottlerocketSettings({ clusterName: "Foo", enableAdminContainer: false });
    const toml = serializeBottlerocketToml(s);
    expect(toml).toContain("[settings.ecs]");
    expect(toml).toContain('cluster = "Foo"');
    const parsed = TOML.parse(toml);
    expect(parsed).toHaveProperty("settings");
  });
});

describe("encodeUserData", () => {
  it("returns base64 of the input string", () => {
    const encoded = encodeUserData("hello");
    expect(encoded).toBe(Buffer.from("hello", "utf-8").toString("base64"));
    expect(Buffer.from(encoded, "base64").toString("utf-8")).toBe("hello");
  });
});

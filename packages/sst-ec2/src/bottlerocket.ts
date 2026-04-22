import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import TOML from "@iarna/toml";
import type { Architecture, BottlerocketVariant } from "./types.js";

export interface BottlerocketSettings {
  ecs: {
    cluster: string;
    "enable-spot-instance-draining"?: boolean;
    "metadata-service-rps"?: number;
    "metadata-service-burst"?: number;
  };
  "host-containers": {
    admin: { enabled: boolean; "user-data"?: string; "superpowered"?: boolean };
    control: { enabled: boolean };
  };
  kernel: {
    sysctl: Record<string, string>;
  };
}

export interface BuildUserDataArgs {
  clusterName: string;
  enableAdminContainer: boolean;
}

export function buildBottlerocketSettings(args: BuildUserDataArgs): BottlerocketSettings {
  return {
    ecs: {
      cluster: args.clusterName,
      "enable-spot-instance-draining": true,
      "metadata-service-rps": 4096,
      "metadata-service-burst": 8192,
    },
    "host-containers": {
      admin: { enabled: args.enableAdminContainer, superpowered: args.enableAdminContainer },
      control: { enabled: true },
    },
    kernel: {
      sysctl: {
        "net.ipv4.ip_local_port_range": "1024 65535",
        "fs.inotify.max_user_instances": "8192",
        "net.core.somaxconn": "4096",
      },
    },
  };
}

export function serializeBottlerocketToml(settings: BottlerocketSettings): string {
  const tomlInput: TOML.JsonMap = {
    settings: {
      ecs: { ...settings.ecs },
      "host-containers": {
        admin: { ...settings["host-containers"].admin },
        control: { ...settings["host-containers"].control },
      },
      kernel: {
        sysctl: { ...settings.kernel.sysctl },
      },
    },
  };
  return TOML.stringify(tomlInput);
}

export function encodeUserData(toml: string): string {
  return Buffer.from(toml, "utf-8").toString("base64");
}

export function lookupBottlerocketAmi(
  variant: BottlerocketVariant,
  arch: Architecture,
  version: string,
): pulumi.Output<string> {
  const archToken = arch === "arm64" ? "arm64" : "x86_64";
  const name = `/aws/service/bottlerocket/${variant}/${archToken}/${version}/image_id`;
  return aws.ssm.getParameterOutput({ name }).value;
}

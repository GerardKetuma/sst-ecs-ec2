import type { Input, Architecture, NetworkMode, BottlerocketVariant } from "./types.js";

export function normalizeArchitecture(arch: Input<Architecture> | undefined): Architecture {
  if (arch === undefined) return "x86_64";
  if (typeof arch !== "string") {
    throw new Error("architecture must be a resolved string; wrap in .apply() if it's an Output");
  }
  if (arch !== "x86_64" && arch !== "arm64") {
    throw new Error(`Unsupported architecture: ${String(arch)}`);
  }
  return arch;
}

export function normalizeNetworkMode(mode: Input<NetworkMode> | undefined): NetworkMode {
  if (mode === undefined) return "awsvpc";
  if (typeof mode !== "string") {
    throw new Error("networkMode must be a resolved string");
  }
  if (mode !== "awsvpc" && mode !== "bridge" && mode !== "host") {
    throw new Error(`Unsupported networkMode: ${String(mode)}`);
  }
  return mode;
}

export function normalizeVariant(
  variant: Input<BottlerocketVariant> | undefined,
): BottlerocketVariant {
  if (variant === undefined) return "aws-ecs-2";
  if (typeof variant !== "string") {
    throw new Error("variant must be a resolved string");
  }
  if (variant !== "aws-ecs-1" && variant !== "aws-ecs-2") {
    throw new Error(`Unsupported Bottlerocket variant: ${String(variant)}`);
  }
  return variant;
}

export function normalizeCpu(cpu: number | undefined): number | undefined {
  if (cpu === undefined) return undefined;
  if (!Number.isFinite(cpu) || cpu <= 0 || !Number.isInteger(cpu)) {
    throw new Error(`cpu must be a positive integer in CPU units (1024 = 1 vCPU), got ${cpu}`);
  }
  return cpu;
}

export function normalizeMemory(memory: number | undefined): number | undefined {
  if (memory === undefined) return undefined;
  if (!Number.isFinite(memory) || memory <= 0 || !Number.isInteger(memory)) {
    throw new Error(`memory must be a positive integer in MiB, got ${memory}`);
  }
  return memory;
}

export function defaultInstanceType(arch: Architecture): string {
  return arch === "arm64" ? "t4g.medium" : "t3.medium";
}

export function archToSsmToken(arch: Architecture): "x86_64" | "arm64" {
  return arch;
}

export function archToEcsToken(arch: Architecture): "X86_64" | "ARM64" {
  return arch === "arm64" ? "ARM64" : "X86_64";
}

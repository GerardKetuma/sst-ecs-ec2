import * as pulumi from "@pulumi/pulumi";
import type { ContainerArgs, HealthCheck, Input } from "./types.js";

export interface SingleContainerInput {
  image?: Input<string>;
  command?: Input<Input<string>[]>;
  entrypoint?: Input<Input<string>[]>;
  environment?: Input<Record<string, Input<string>>>;
  environmentFiles?: Input<Input<string>[]>;
  secrets?: Input<Record<string, Input<string>>>;
  health?: Input<HealthCheck>;
  containers?: ContainerArgs[];
}

export interface BuildContainersResult {
  containers: ContainerArgs[];
}

export function buildContainers(
  name: string,
  args: SingleContainerInput,
  extra?: { portMappings?: ContainerArgs["portMappings"] },
): ContainerArgs[] {
  if (args.containers && args.containers.length > 0) {
    if (
      args.image ||
      args.command ||
      args.entrypoint ||
      args.environment ||
      args.environmentFiles ||
      args.secrets ||
      args.health
    ) {
      throw new Error(
        "Cannot provide both `containers` and top-level `image`/`command`/`environment` etc.",
      );
    }
    return args.containers;
  }
  if (!args.image) {
    throw new Error("`image` is required when `containers` is not provided");
  }
  const container: ContainerArgs = {
    name,
    image: args.image,
    command: args.command,
    entrypoint: args.entrypoint,
    environment: args.environment,
    environmentFiles: args.environmentFiles,
    secrets: args.secrets,
    health: args.health,
    ...(extra?.portMappings ? { portMappings: extra.portMappings } : {}),
  };
  return [container];
}

export function firstContainerName(containers: ContainerArgs[]): Input<string> {
  const first = containers[0];
  if (!first) throw new Error("at least one container is required");
  return first.name;
}

export function collectEnvironmentFiles(
  containers: ContainerArgs[],
): pulumi.Input<pulumi.Input<string>[]> {
  const collected: pulumi.Input<pulumi.Input<string>[]>[] = containers
    .map((c) => c.environmentFiles)
    .filter((v): v is pulumi.Input<pulumi.Input<string>[]> => v !== undefined);
  if (collected.length === 0) return [];
  return pulumi.all(collected.map((c) => pulumi.output(c))).apply((arrays) => arrays.flat());
}

export function collectSecretArns(
  containers: ContainerArgs[],
): pulumi.Output<string[]> {
  const collected: pulumi.Input<Record<string, pulumi.Input<string>>>[] = containers
    .map((c) => c.secrets)
    .filter(
      (v): v is pulumi.Input<Record<string, pulumi.Input<string>>> => v !== undefined,
    );
  if (collected.length === 0) return pulumi.output([]);
  return pulumi
    .all(collected.map((c) => pulumi.output(c)))
    .apply((records) => records.flatMap((r) => Object.values(r)));
}

import * as pulumi from "@pulumi/pulumi";
import type { ContainerArgs, ContainerImage, HealthCheck, Input } from "./types.js";
import { type ImageBuildContext, resolveImage } from "./image-builder.js";

export interface SingleContainerInput {
  image?: ContainerImage;
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

export interface BuildContainersOptions {
  portMappings?: ContainerArgs["portMappings"];
  imageBuildContext?: ImageBuildContext;
}

export function buildContainers(
  name: string,
  args: SingleContainerInput,
  opts?: BuildContainersOptions,
): ContainerArgs[] {
  const ctx = opts?.imageBuildContext;
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
    return args.containers.map((c, idx) => resolveContainerImage(c, ctx, `${name}-${idx}`));
  }
  if (!args.image) {
    throw new Error("`image` is required when `containers` is not provided");
  }
  const container: ContainerArgs = {
    name,
    image: resolveImage(`${name}`, args.image, ctx),
    command: args.command,
    entrypoint: args.entrypoint,
    environment: args.environment,
    environmentFiles: args.environmentFiles,
    secrets: args.secrets,
    health: args.health,
    ...(opts?.portMappings ? { portMappings: opts.portMappings } : {}),
  };
  return [container];
}

function resolveContainerImage(
  c: ContainerArgs,
  ctx: ImageBuildContext | undefined,
  fallbackName: string,
): ContainerArgs {
  const resolvedImage = resolveImage(
    typeof c.name === "string" ? c.name : fallbackName,
    c.image,
    ctx,
  );
  return { ...c, image: resolvedImage };
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

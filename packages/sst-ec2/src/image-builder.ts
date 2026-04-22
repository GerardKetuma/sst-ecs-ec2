import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as docker from "@pulumi/docker-build";
import type { Architecture, ContainerImage, ContainerImageBuildSpec, Input } from "./types.js";

export type ImageBuildArgs = ContainerImageBuildSpec;
export type ImageInput = ContainerImage;

export function isImageBuildSpec(img: ImageInput): img is ImageBuildArgs {
  if (typeof img === "string") return false;
  if (pulumi.Output.isInstance(img)) return false;
  return typeof img === "object" && img !== null && "context" in (img as object);
}

export function platformForArchitecture(arch: Architecture): "linux/amd64" | "linux/arm64" {
  return arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

export interface ImageBuildContext {
  repository: aws.ecr.Repository;
  authToken: pulumi.Output<aws.ecr.GetAuthorizationTokenResult>;
  architecture: Architecture;
  parent: pulumi.ComponentResource;
}

export function buildImage(
  name: string,
  spec: ImageBuildArgs,
  ctx: ImageBuildContext,
): pulumi.Output<string> {
  const platform = pulumi
    .output(spec.platform)
    .apply((p) => (p ?? platformForArchitecture(ctx.architecture)) as docker.types.enums.Platform);

  const dockerfileLocation = spec.dockerfile
    ? pulumi
        .all([pulumi.output(spec.context), pulumi.output(spec.dockerfile as Input<string>)])
        .apply(([context, file]) => `${context.replace(/\/+$/, "")}/${file}`)
    : undefined;

  const registryAddress = ctx.repository.repositoryUrl.apply((u) => u.split("/")[0]!);
  const tag = pulumi.interpolate`${ctx.repository.repositoryUrl}:${name}`;

  const image = new docker.Image(
    `${name}Image`,
    {
      context: { location: spec.context },
      ...(dockerfileLocation ? { dockerfile: { location: dockerfileLocation } } : {}),
      platforms: [platform],
      buildArgs: spec.args,
      target: spec.target,
      tags: [tag],
      push: true,
      registries: [
        {
          address: registryAddress,
          username: ctx.authToken.userName,
          password: ctx.authToken.password,
        },
      ],
    },
    { parent: ctx.parent },
  );

  return image.ref;
}

export function resolveImage(
  name: string,
  image: ImageInput,
  ctx: ImageBuildContext | undefined,
): pulumi.Output<string> {
  if (isImageBuildSpec(image)) {
    if (!ctx) {
      throw new Error(
        `Container \`${name}\` provided a build spec but the cluster has no ECR repository ` +
          `(likely because it was referenced via ClusterEc2.get()). Pass a pre-built image URI ` +
          `instead, or create the cluster in this stack.`,
      );
    }
    return buildImage(name, image, ctx);
  }
  return pulumi.output(image);
}

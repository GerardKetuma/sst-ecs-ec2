import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { buildContainers } from "../src/containers.js";
import {
  buildImage,
  isImageBuildSpec,
  platformForArchitecture,
  resolveImage,
  type ImageBuildContext,
} from "../src/image-builder.js";
import { ClusterEc2 } from "../src/cluster-ec2.js";
import { ServiceEc2 } from "../src/service-ec2.js";
import { TaskEc2 } from "../src/task-ec2.js";
import type { ClusterHandles, VpcShape } from "../src/types.js";

function testVpc(): VpcShape {
  return {
    id: "vpc-123",
    securityGroups: ["sg-111"],
    containerSubnets: ["subnet-a", "subnet-b"],
    loadBalancerSubnets: ["subnet-c", "subnet-d"],
    publicSubnets: ["subnet-e", "subnet-f"],
  };
}

function resolve<T>(o: pulumi.Input<T> | undefined): Promise<T | undefined> {
  return new Promise((ok) => {
    pulumi.output(o).apply((v) => ok(v));
  });
}

class Parent extends pulumi.ComponentResource {
  constructor(name: string) {
    super("test:Parent", name, {}, {});
  }
}

function makeBuildContext(name: string): ImageBuildContext {
  const parent = new Parent(name);
  const repository = new aws.ecr.Repository(
    `${name}Repo`,
    { name: `${name}-repo`, forceDelete: true },
    { parent },
  );
  const authToken = aws.ecr.getAuthorizationTokenOutput(
    { registryId: repository.registryId },
    { parent },
  );
  return { repository, authToken, architecture: "x86_64", parent };
}

describe("image-builder helpers", () => {
  it("isImageBuildSpec distinguishes strings, Outputs, and build specs", () => {
    expect(isImageBuildSpec("nginx:latest")).toBe(false);
    expect(isImageBuildSpec(pulumi.output("nginx:latest"))).toBe(false);
    expect(isImageBuildSpec({ context: "./app" })).toBe(true);
  });

  it("platformForArchitecture maps arch tokens to docker platforms", () => {
    expect(platformForArchitecture("x86_64")).toBe("linux/amd64");
    expect(platformForArchitecture("arm64")).toBe("linux/arm64");
  });

  it("resolveImage passes through a string URI unchanged", async () => {
    const ref = await resolve(resolveImage("pass", "nginx:1.27", undefined));
    expect(ref).toBe("nginx:1.27");
  });

  it("resolveImage builds and pushes to ECR when given a build spec", async () => {
    const ctx = makeBuildContext("Build1");
    const ref = await resolve(resolveImage("Build1", { context: "./app" }, ctx));
    expect(typeof ref).toBe("string");
    expect(ref).toContain("sha256:");
  });

  it("resolveImage throws when build spec is passed without a context", () => {
    expect(() =>
      resolveImage("X", { context: "./app" }, undefined),
    ).toThrow(/no ECR repository/);
  });

  it("buildImage honors an explicit platform override", async () => {
    const ctx = makeBuildContext("Build2");
    ctx.architecture = "x86_64";
    const ref = await resolve(
      buildImage("Svc", { context: "./app", platform: "linux/arm64" }, ctx),
    );
    expect(typeof ref).toBe("string");
  });
});

describe("ClusterEc2 image repository wiring", () => {
  it("exposes an ECR repository and auth token on the cluster", async () => {
    const cluster = new ClusterEc2("ImgCluster", { vpc: testVpc() });
    expect(cluster.imageRepository).toBeDefined();
    expect(cluster.nodes.repository).toBeDefined();
    const url = await resolve(cluster.imageRepository.repository.repositoryUrl);
    expect(url).toMatch(/dkr\.ecr\./);
  });

  it("derives a lowercase repository name from the cluster name", async () => {
    const cluster = new ClusterEc2("ImgCluster", { vpc: testVpc() });
    const repoName = await resolve(cluster.imageRepository.repository.name);
    expect(repoName).toBe("imgclustercluster-images");
  });
});

describe("ServiceEc2 with build spec", () => {
  it("builds the image via the cluster's ECR repository", async () => {
    const cluster = new ClusterEc2("SvcCluster", { vpc: testVpc() });
    const svc = new ServiceEc2("SvcBuilt", {
      cluster,
      image: { context: "./examples/hello-hono/app" },
    });
    const td = await resolve(svc.taskDefinition.containerDefinitions);
    expect(td).toBeDefined();
    const parsed = JSON.parse(td as string);
    expect(parsed[0].image).toContain("sha256:");
  });
});

describe("containers with build specs", () => {
  it("uses unique fallback build names for Output-backed container names", async () => {
    const ctx = makeBuildContext("Build3");
    const containers = buildContainers(
      "SvcComputed",
      {
        containers: [
          { name: pulumi.output("api"), image: { context: "./api" } },
          { name: pulumi.output("worker"), image: { context: "./worker" } },
        ],
      },
      { imageBuildContext: ctx },
    );

    const refs = await Promise.all(containers.map((c) => resolve(c.image)));
    expect(refs[0]).toContain("SvcComputed-0Image");
    expect(refs[1]).toContain("SvcComputed-1Image");
    expect(refs[0]).not.toBe(refs[1]);
  });
});

describe("TaskEc2 with build spec", () => {
  it("builds the image via the cluster's ECR repository", async () => {
    const cluster = new ClusterEc2("TaskCluster", { vpc: testVpc() });
    const task = new TaskEc2("BatchJob", {
      cluster,
      image: { context: "./examples/batch-task/job" },
    });
    const td = await resolve(task.taskDefinition.containerDefinitions);
    const parsed = JSON.parse(td as string);
    expect(parsed[0].image).toContain("sha256:");
  });
});

describe("ClusterEc2.get() referenced cluster", () => {
  it("rejects build specs because no ECR repo is attached", () => {
    const handles: ClusterHandles = ClusterEc2.get("Existing", {
      clusterName: "existing-cluster",
      capacityProviderName: "existing-cp",
      vpc: testVpc(),
    });
    expect(
      () =>
        new ServiceEc2("SvcGet", {
          cluster: handles,
          image: { context: "./app" },
        }),
    ).toThrow(/no ECR repository/);
  });

  it("still accepts pre-built image URIs", async () => {
    const handles: ClusterHandles = ClusterEc2.get("Existing2", {
      clusterName: "existing-cluster",
      capacityProviderName: "existing-cp",
      vpc: testVpc(),
    });
    const svc = new ServiceEc2("SvcGetUri", {
      cluster: handles,
      image: "nginx:latest",
    });
    const td = await resolve(svc.taskDefinition.containerDefinitions);
    const parsed = JSON.parse(td as string);
    expect(parsed[0].image).toBe("nginx:latest");
  });
});

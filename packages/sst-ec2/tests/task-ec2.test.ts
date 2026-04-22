import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { TaskEc2 } from "../src/task-ec2.js";
import type { ClusterHandles, VpcShape } from "../src/types.js";

function testVpc(): VpcShape {
  return {
    id: "vpc-123",
    securityGroups: ["sg-111"],
    containerSubnets: ["subnet-aaa", "subnet-bbb"],
  };
}

function fakeCluster(): ClusterHandles {
  const cluster = new aws.ecs.Cluster("TaskFakeCluster", {});
  return {
    id: cluster.id,
    arn: cluster.arn,
    name: cluster.name,
    capacityProviderName: pulumi.output("FakeCp"),
    vpc: testVpc(),
    nodes: { cluster },
  };
}

function resolve<T>(o: pulumi.Input<T> | undefined): Promise<T | undefined> {
  return new Promise((ok) => {
    pulumi.output(o).apply((v) => ok(v));
  });
}

describe("TaskEc2", () => {
  it("creates a task definition with EC2 compat, no ecs Service", async () => {
    const task = new TaskEc2("Job", {
      cluster: fakeCluster(),
      image: "alpine:latest",
      command: ["echo", "hi"],
    });
    const compat = await resolve(task.taskDefinition.requiresCompatibilities);
    expect(compat).toEqual(["EC2"]);
    expect(task.publicSecurityGroup).toBeUndefined();
  });

  it("creates a public SG when `public: true`", () => {
    const task = new TaskEc2("PubJob", {
      cluster: fakeCluster(),
      image: "alpine:latest",
      public: true,
    });
    expect(task.publicSecurityGroup).toBeDefined();
  });

  it("link includes RunTask and PassRole permissions", () => {
    const task = new TaskEc2("LinkJob", { cluster: fakeCluster(), image: "alpine:latest" });
    const link = task.getSSTLink();
    const actions = link.include?.flatMap((i) => {
      const a = i.actions;
      if (Array.isArray(a)) return a;
      return [];
    });
    expect(actions).toContain("ecs:RunTask");
    expect(actions).toContain("iam:PassRole");
  });
});

import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { TaskEc2 } from "../src/task-ec2.js";
import type { ClusterHandles, VpcShape } from "../src/types.js";

function testVpc(): VpcShape {
  return {
    id: "vpc-t",
    securityGroups: ["sg-t"],
    containerSubnets: ["subnet-tcn"],
    publicSubnets: ["subnet-tpub"],
  };
}

function makeCluster(name: string): ClusterHandles {
  const cluster = new aws.ecs.Cluster(name, {});
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

describe("TaskEc2 getSSTLink — regression for B1 (clusterArn)", () => {
  it("exposes the real clusterArn, not an empty string", async () => {
    const task = new TaskEc2("Runme", {
      cluster: makeCluster("TaskClusterReal"),
      image: "alpine:latest",
    });
    const link = task.getSSTLink();
    const clusterArn = await resolve(link.properties.clusterArn);
    expect(clusterArn).toBeTruthy();
    expect(clusterArn).toMatch(/^arn:aws:ecs:/);
  });

  it("exposes clusterName, capacityProviderName, taskDefinitionArn, subnets, securityGroups in link properties", async () => {
    const task = new TaskEc2("Full", {
      cluster: makeCluster("TaskClusterFull"),
      image: "alpine:latest",
    });
    const link = task.getSSTLink();
    expect(link.properties.clusterName).toBeDefined();
    expect(link.properties.capacityProviderName).toBeDefined();
    expect(link.properties.taskDefinitionArn).toBeDefined();
    expect(link.properties.subnets).toBeDefined();
    expect(link.properties.securityGroups).toBeDefined();
    expect(link.properties.assignPublicIp).toBe("false");
  });

  it("flips assignPublicIp to 'true' when public=true", async () => {
    const task = new TaskEc2("Pub", {
      cluster: makeCluster("TaskClusterPub"),
      image: "alpine:latest",
      public: true,
    });
    const link = task.getSSTLink();
    expect(link.properties.assignPublicIp).toBe("true");
  });
});

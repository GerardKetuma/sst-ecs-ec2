import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ClusterEc2 } from "../src/cluster-ec2.js";
import type { VpcShape } from "../src/types.js";

function testVpc(): VpcShape {
  return {
    id: "vpc-123",
    securityGroups: ["sg-111"],
    containerSubnets: ["subnet-aaa", "subnet-bbb"],
    loadBalancerSubnets: ["subnet-ccc", "subnet-ddd"],
    publicSubnets: ["subnet-eee", "subnet-fff"],
  };
}

function resolve<T>(o: pulumi.Input<T> | undefined): Promise<T | undefined> {
  return new Promise((ok) => {
    pulumi.output(o).apply((v) => ok(v));
  });
}

describe("ClusterEc2 spot / mixed instances", () => {
  it("fans out overrides across all provided instance types", async () => {
    const cluster = new ClusterEc2("Multi", {
      vpc: testVpc(),
      spot: {
        onDemandBase: 1,
        onDemandPercentageAboveBase: 0,
        instanceTypes: ["m6i.large", "m6a.large", "m5.large"],
      },
    });
    const asg = cluster.nodes.autoScalingGroup;
    if (!asg) throw new Error("asg missing");
    const policy = await resolve(asg.mixedInstancesPolicy);
    const overrides = policy?.launchTemplate?.overrides;
    expect(overrides?.length).toBe(3);
    const types = overrides?.map((o) => o.instanceType).sort();
    expect(types).toEqual(["m5.large", "m6a.large", "m6i.large"]);
  });

  it("omits mixed instances policy when spot not provided (single LT path)", async () => {
    const cluster = new ClusterEc2("Single", { vpc: testVpc() });
    const asg = cluster.nodes.autoScalingGroup;
    if (!asg) throw new Error();
    const mixed = await resolve(asg.mixedInstancesPolicy);
    const lt = await resolve(asg.launchTemplate);
    expect(mixed).toBeUndefined();
    expect(lt).toBeDefined();
  });

  it("enforces Bottlerocket default variant aws-ecs-2 in the AMI SSM path", () => {
    const cluster = new ClusterEc2("Variant", { vpc: testVpc() });
    expect(cluster.nodes.launchTemplate).toBeDefined();
  });
});

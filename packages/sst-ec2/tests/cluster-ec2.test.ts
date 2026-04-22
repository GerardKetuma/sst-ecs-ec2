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

describe("ClusterEc2", () => {
  it("constructs without throwing on defaults", () => {
    const cluster = new ClusterEc2("Demo", { vpc: testVpc() });
    expect(cluster).toBeDefined();
    expect(cluster.nodes.cluster).toBeDefined();
    expect(cluster.nodes.launchTemplate).toBeDefined();
    expect(cluster.nodes.autoScalingGroup).toBeDefined();
    expect(cluster.nodes.capacityProvider).toBeDefined();
    expect(cluster.nodes.clusterCapacityProviders).toBeDefined();
    expect(cluster.nodes.instanceRole).toBeDefined();
    expect(cluster.nodes.instanceProfile).toBeDefined();
    expect(cluster.nodes.trunking).toBeDefined();
  });

  it("omits the trunking resource when disabled", () => {
    const cluster = new ClusterEc2("NoTrunk", { vpc: testVpc(), enableTrunking: false });
    expect(cluster.nodes.trunking).toBeUndefined();
  });

  it("passes targetCapacity default of 80 to the capacity provider", async () => {
    const cluster = new ClusterEc2("Tc", { vpc: testVpc() });
    const asp = cluster.nodes.capacityProvider;
    if (!asp) throw new Error("capacityProvider missing");
    const provider = await resolve(asp.autoScalingGroupProvider);
    expect(provider?.managedScaling?.targetCapacity).toBe(80);
    expect(provider?.managedScaling?.instanceWarmupPeriod).toBe(90);
    expect(provider?.managedTerminationProtection).toBe("ENABLED");
  });

  it("configures mixed instances policy when spot is provided", async () => {
    const cluster = new ClusterEc2("Spot", {
      vpc: testVpc(),
      spot: { onDemandBase: 1, onDemandPercentageAboveBase: 20 },
    });
    const asg = cluster.nodes.autoScalingGroup;
    if (!asg) throw new Error("asg missing");
    const policy = await resolve(asg.mixedInstancesPolicy);
    expect(policy).toBeDefined();
    expect(policy?.instancesDistribution?.onDemandBaseCapacity).toBe(1);
    expect(policy?.instancesDistribution?.onDemandPercentageAboveBaseCapacity).toBe(20);
    expect(policy?.launchTemplate?.launchTemplateSpecification?.version).not.toBe("$Latest");
  });

  it("validates capacity ranges", () => {
    expect(() => new ClusterEc2("Bad", { vpc: testVpc(), capacity: { min: 5, max: 3 } })).toThrow();
    expect(
      () => new ClusterEc2("Bad2", { vpc: testVpc(), capacity: { targetCapacity: 0 } }),
    ).toThrow();
  });

  it("tags the ASG with AmazonECSManaged and protectFromScaleIn is true", async () => {
    const cluster = new ClusterEc2("T", { vpc: testVpc() });
    const asg = cluster.nodes.autoScalingGroup;
    if (!asg) throw new Error();
    const protectFromScaleIn = await resolve(asg.protectFromScaleIn);
    const tags = await resolve(asg.tags);
    expect(protectFromScaleIn).toBe(true);
    expect(tags?.some((t) => t.key === "AmazonECSManaged")).toBe(true);
  });

  it("pins the ASG launch template version instead of relying on $Latest", async () => {
    const cluster = new ClusterEc2("Pinned", { vpc: testVpc() });
    const asg = cluster.nodes.autoScalingGroup;
    if (!asg) throw new Error("asg missing");
    const launchTemplate = await resolve(asg.launchTemplate);
    expect(launchTemplate?.version).not.toBe("$Latest");
  });
});

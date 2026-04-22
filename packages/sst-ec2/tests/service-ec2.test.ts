import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceEc2 } from "../src/service-ec2.js";
import type { ClusterHandles, VpcShape } from "../src/types.js";
import * as aws from "@pulumi/aws";

function testVpc(): VpcShape {
  return {
    id: "vpc-123",
    securityGroups: ["sg-111"],
    containerSubnets: ["subnet-aaa", "subnet-bbb"],
    loadBalancerSubnets: ["subnet-ccc", "subnet-ddd"],
    publicSubnets: ["subnet-eee", "subnet-fff"],
  };
}

function fakeCluster(): ClusterHandles {
  const cluster = new aws.ecs.Cluster("FakeCluster", {});
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

describe("ServiceEc2", () => {
  it("creates task def with requiresCompatibilities: EC2 and awsvpc networkMode", async () => {
    const svc = new ServiceEc2("Api", {
      cluster: fakeCluster(),
      image: "nginx:latest",
      cpu: 256,
      memory: 512,
    });
    const compat = await resolve(svc.taskDefinition.requiresCompatibilities);
    const mode = await resolve(svc.taskDefinition.networkMode);
    expect(compat).toEqual(["EC2"]);
    expect(mode).toBe("awsvpc");
  });

  it("creates a service with capacityProviderStrategies (not launchType)", async () => {
    const svc = new ServiceEc2("Api2", {
      cluster: fakeCluster(),
      image: "nginx:latest",
    });
    const launchType = await resolve(svc.service.launchType);
    const cps = await resolve(svc.service.capacityProviderStrategies);
    expect(launchType).toBeFalsy();
    expect(cps).toBeDefined();
    expect(cps?.[0]?.weight).toBe(100);
  });

  it("sets default placement strategies: spread(AZ) then binpack(memory)", async () => {
    const svc = new ServiceEc2("Place", {
      cluster: fakeCluster(),
      image: "nginx:latest",
    });
    const strategies = await resolve(svc.service.orderedPlacementStrategies);
    expect(strategies?.length).toBe(2);
    expect(strategies?.[0]?.type).toBe("spread");
    expect(strategies?.[0]?.field).toBe("attribute:ecs.availability-zone");
    expect(strategies?.[1]?.type).toBe("binpack");
    expect(strategies?.[1]?.field).toBe("memory");
  });

  it("enables circuit breaker + rollback + executeCommand by default", async () => {
    const svc = new ServiceEc2("Cb", {
      cluster: fakeCluster(),
      image: "nginx:latest",
    });
    const cb = await resolve(svc.service.deploymentCircuitBreaker);
    const eec = await resolve(svc.service.enableExecuteCommand);
    expect(cb?.enable).toBe(true);
    expect(cb?.rollback).toBe(true);
    expect(eec).toBe(true);
  });

  it("creates an ALB + target group when loadBalancer is provided", () => {
    const svc = new ServiceEc2("Lb", {
      cluster: fakeCluster(),
      image: "nginx:latest",
      loadBalancer: { ports: [{ listen: "80/http" }] },
    });
    expect(svc.loadBalancer).toBeDefined();
    expect(svc.url).toBeDefined();
  });

  it("rejects mixing top-level image with containers[]", () => {
    expect(
      () =>
        new ServiceEc2("Bad", {
          cluster: fakeCluster(),
          image: "nginx",
          containers: [{ name: "a", image: "b" }],
        }),
    ).toThrow();
  });

  it("exposes getSSTLink() with ECS describe/update actions", () => {
    const svc = new ServiceEc2("Link", { cluster: fakeCluster(), image: "nginx:latest" });
    const link = svc.getSSTLink();
    expect(link.properties.serviceName).toBeDefined();
    expect(link.properties.taskDefinitionArn).toBeDefined();
    expect(link.include?.[0]?.type).toBe("aws.permission");
  });
});

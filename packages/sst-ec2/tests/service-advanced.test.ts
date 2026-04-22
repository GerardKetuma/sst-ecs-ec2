import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceEc2 } from "../src/service-ec2.js";
import type { ClusterHandles, VpcShape } from "../src/types.js";

function testVpc(withCloudmap = false): VpcShape {
  return {
    id: "vpc-svc",
    securityGroups: ["sg-svc"],
    containerSubnets: ["subnet-aa"],
    loadBalancerSubnets: ["subnet-bb"],
    publicSubnets: ["subnet-cc"],
    ...(withCloudmap ? { cloudmapNamespaceId: "ns-123", cloudmapNamespaceName: "svc.local" } : {}),
  };
}

function resolve<T>(o: pulumi.Input<T> | undefined): Promise<T | undefined> {
  return new Promise((ok) => {
    pulumi.output(o).apply((v) => ok(v));
  });
}

function makeCluster(withCloudmap = false, withCcp = false): ClusterHandles {
  const cluster = new aws.ecs.Cluster(
    `FakeCluster${withCloudmap ? "Cm" : ""}${withCcp ? "Ccp" : ""}`,
    {},
  );
  const ccp = withCcp
    ? new aws.ecs.ClusterCapacityProviders(
        `FakeCcp${withCloudmap ? "Cm" : ""}`,
        {
          clusterName: cluster.name,
          capacityProviders: ["FakeCp"],
        },
      )
    : undefined;
  return {
    id: cluster.id,
    arn: cluster.arn,
    name: cluster.name,
    capacityProviderName: pulumi.output("FakeCp"),
    vpc: testVpc(withCloudmap),
    nodes: { cluster, clusterCapacityProviders: ccp },
  };
}

describe("ServiceEc2 — dependsOn + CloudMap + IAM scoping", () => {
  it("wires an explicit dependsOn on the ClusterCapacityProviders when provided", async () => {
    const svc = new ServiceEc2("DepSvc", {
      cluster: makeCluster(false, true),
      image: "nginx:latest",
    });
    expect(svc.service).toBeDefined();
    const urn = await resolve(svc.service.urn);
    expect(urn).toBeDefined();
  });

  it("skips dependsOn cleanly when the cluster has no ccp node (Cluster.get path)", () => {
    const svc = new ServiceEc2("DepSvc2", {
      cluster: makeCluster(false, false),
      image: "nginx:latest",
    });
    expect(svc.service).toBeDefined();
  });

  it("creates a CloudMap service when serviceRegistry + vpc.cloudmapNamespaceId are set", async () => {
    const svc = new ServiceEc2("CmSvc", {
      cluster: makeCluster(true, false),
      image: "nginx:latest",
      serviceRegistry: { port: 8080 },
    });
    expect(svc.cloudmapService).toBeDefined();
    const dnsCfg = await resolve(svc.cloudmapService?.dnsConfig);
    expect(dnsCfg?.namespaceId).toBe("ns-123");
    const sr = await resolve(svc.service.serviceRegistries);
    expect(sr?.port).toBe(8080);
  });

  it("throws when serviceRegistry is set without a cloudmap namespace on the vpc", () => {
    expect(
      () =>
        new ServiceEc2("CmSvcBad", {
          cluster: makeCluster(false, false),
          image: "nginx:latest",
          serviceRegistry: { port: 8080 },
        }),
    ).toThrow(/cloudmapNamespaceId/);
  });

  it("passes declared secret ARNs through to execution role", async () => {
    const svc = new ServiceEc2("SecSvc", {
      cluster: makeCluster(false, false),
      image: "nginx:latest",
      secrets: {
        DB_PASS: "arn:aws:secretsmanager:us-east-1:123:secret:db-AB12",
      },
    });
    const inline = await resolve(svc.executionRole.inlinePolicies);
    const policy = String(inline?.[0]?.policy);
    expect(policy).toContain("db-AB12");
  });

  it("computes https URL when any listener uses https", async () => {
    const svc = new ServiceEc2("HttpsSvc", {
      cluster: makeCluster(false, false),
      image: "nginx:latest",
      loadBalancer: {
        ports: [{ listen: "443/https", forward: "3000/http" }],
        domain: { name: "api.example.com" },
      },
    });
    const url = await resolve(svc.url);
    expect(url?.startsWith("https://")).toBe(true);
  });
});

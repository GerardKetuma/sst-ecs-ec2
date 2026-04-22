import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ComponentResource } from "@pulumi/pulumi";
import { createLoadBalancer } from "../src/load-balancer.js";
import type { VpcShape } from "../src/types.js";

class Dummy extends ComponentResource {
  constructor(name: string) {
    super("sst-ec2:test:Dummy", name, {}, {});
  }
}

function testVpc(): VpcShape {
  return {
    id: "vpc-lb",
    securityGroups: ["sg-lb"],
    containerSubnets: ["subnet-priv1"],
    publicSubnets: ["subnet-pub1", "subnet-pub2"],
    loadBalancerSubnets: ["subnet-pub1", "subnet-pub2"],
  };
}

function resolve<T>(o: pulumi.Input<T> | undefined): Promise<T | undefined> {
  return new Promise((ok) => {
    pulumi.output(o).apply((v) => ok(v));
  });
}

describe("createLoadBalancer HTTPS + domain", () => {
  it("creates and validates an ACM cert when HTTPS listener has a hosted zone", async () => {
    const parent = new Dummy("LbHttps");
    const result = createLoadBalancer(
      "App",
      {
        ports: [{ listen: "443/https", forward: "3000/http" }],
        domain: { name: "api.example.com", hostedZoneId: "Z123456ABC" },
      },
      testVpc(),
      parent,
    );
    expect(result.certificate).toBeDefined();
    expect(result.validationRecord).toBeDefined();
    expect(result.certificateValidation).toBeDefined();
    const certDomain = await resolve(result.certificate?.domainName);
    expect(certDomain).toBe("api.example.com");
  });

  it("throws when HTTPS auto-cert is requested without a hosted zone", () => {
    const parent = new Dummy("LbHttpsNoZone");
    expect(() =>
      createLoadBalancer(
        "App",
        {
          ports: [{ listen: "443/https", forward: "3000/http" }],
          domain: { name: "api.example.com" },
        },
        testVpc(),
        parent,
      ),
    ).toThrow(/hostedZoneId/);
  });

  it("reuses a provided cert ARN instead of creating one", () => {
    const parent = new Dummy("LbHttpsExistingCert");
    const result = createLoadBalancer(
      "App",
      {
        ports: [{ listen: "443/https" }],
        domain: {
          name: "api.example.com",
          cert: "arn:aws:acm:us-east-1:123:certificate/abc",
        },
      },
      testVpc(),
      parent,
    );
    expect(result.certificate).toBeUndefined();
  });

  it("creates a Route53 alias record when hostedZoneId is provided", async () => {
    const parent = new Dummy("LbDns");
    const result = createLoadBalancer(
      "App",
      {
        ports: [{ listen: "80/http" }],
        domain: { name: "api.example.com", hostedZoneId: "Z123456ABC" },
      },
      testVpc(),
      parent,
    );
    expect(result.dnsRecord).toBeDefined();
    const zoneId = await resolve(result.dnsRecord?.zoneId);
    expect(zoneId).toBe("Z123456ABC");
  });

  it("skips DNS alias when hostedZoneId absent", () => {
    const parent = new Dummy("LbNoDns");
    const result = createLoadBalancer(
      "App",
      {
        ports: [{ listen: "80/http" }],
        domain: { name: "api.example.com" },
      },
      testVpc(),
      parent,
    );
    expect(result.dnsRecord).toBeUndefined();
  });

  it("uses matcher '200' by default and respects override", async () => {
    const parent = new Dummy("LbMatcher");
    const def = createLoadBalancer(
      "Def",
      { ports: [{ listen: "80/http" }] },
      testVpc(),
      parent,
    );
    const tgDef = [...def.targetGroups.values()][0];
    const hcDef = await resolve(tgDef?.healthCheck);
    expect(hcDef?.matcher).toBe("200");

    const parent2 = new Dummy("LbMatcherOverride");
    const over = createLoadBalancer(
      "Over",
      {
        ports: [{ listen: "80/http" }],
        healthCheck: { matcher: "200-299" },
      },
      testVpc(),
      parent2,
    );
    const tgOver = [...over.targetGroups.values()][0];
    const hcOver = await resolve(tgOver?.healthCheck);
    expect(hcOver?.matcher).toBe("200-299");
  });

  it("honors transform.loadBalancerSecurityGroup via applyTransform", async () => {
    const parent = new Dummy("LbSgTx");
    const result = createLoadBalancer(
      "Sg",
      {
        ports: [{ listen: "80/http" }],
        transform: {
          loadBalancerSecurityGroup: (sgArgs) => {
            sgArgs.description = "restricted";
          },
        },
      },
      testVpc(),
      parent,
    );
    const desc = await resolve(result.securityGroup.description);
    expect(desc).toBe("restricted");
  });
});

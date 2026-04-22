import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ComponentResource } from "@pulumi/pulumi";
import { createExecutionRole, createInstanceRole, createTaskRole } from "../src/iam.js";

class Dummy extends ComponentResource {
  constructor(name: string) {
    super("sst-ec2:test:Dummy", name, {}, {});
  }
}

function resolve<T>(o: pulumi.Input<T> | undefined): Promise<T | undefined> {
  return new Promise((ok) => {
    pulumi.output(o).apply((v) => ok(v));
  });
}

describe("createInstanceRole", () => {
  it("attaches both EC2-for-ECS and SSM managed policies", async () => {
    const parent = new Dummy("InstRoleParent");
    const { role, instanceProfile } = createInstanceRole("X", {}, parent);
    const arns = await resolve(role.managedPolicyArns);
    expect(arns?.some((a) => a.includes("AmazonEC2ContainerServiceforEC2Role"))).toBe(true);
    expect(arns?.some((a) => a.includes("AmazonSSMManagedInstanceCore"))).toBe(true);
    expect(instanceProfile).toBeDefined();
  });

  it("can attach the CloudWatch agent policy on request", async () => {
    const parent = new Dummy("InstRoleParent2");
    const { role } = createInstanceRole("Y", { attachCloudWatchAgentPolicy: true }, parent);
    const arns = await resolve(role.managedPolicyArns);
    expect(arns?.some((a) => a.includes("CloudWatchAgentServerPolicy"))).toBe(true);
  });
});

describe("createTaskRole", () => {
  it("returns a lookup Role when existingRoleArn is set (no assumeRolePolicy)", async () => {
    const parent = new Dummy("TaskRoleExisting");
    const role = createTaskRole(
      "X",
      { existingRoleArn: "arn:aws:iam::123:role/Existing" },
      parent,
    );
    const arp = await resolve(role.assumeRolePolicy);
    expect(arp).toBeUndefined();
  });

  it("otherwise creates a fresh role with ssmmessages inline policy", async () => {
    const parent = new Dummy("TaskRoleFresh");
    const role = createTaskRole("X", {}, parent);
    const inline = await resolve(role.inlinePolicies);
    expect(inline?.[0]?.name).toBe("inline");
    const policy = inline?.[0]?.policy;
    expect(String(policy)).toContain("ssmmessages:CreateControlChannel");
  });
});

describe("createExecutionRole", () => {
  it("scopes secrets statement to declared secretArns instead of *", async () => {
    const parent = new Dummy("ExecRoleScoped");
    const role = createExecutionRole(
      "X",
      { secretArns: ["arn:aws:secretsmanager:us-east-1:123:secret:foo-AB12"] },
      parent,
    );
    const inline = await resolve(role.inlinePolicies);
    const policy = String(inline?.[0]?.policy);
    expect(policy).toContain("foo-AB12");
    expect(policy).not.toMatch(/"Resource":\s*\[\s*"\*"\s*\]/);
  });

  it("falls back to * when no secretArns declared (task uses runtime fetch)", async () => {
    const parent = new Dummy("ExecRoleWide");
    const role = createExecutionRole("Y", {}, parent);
    const inline = await resolve(role.inlinePolicies);
    const policy = String(inline?.[0]?.policy);
    expect(policy).toContain('"*"');
  });

  it("adds an s3:GetObject statement when environmentFiles provided", async () => {
    const parent = new Dummy("ExecRoleEnv");
    const role = createExecutionRole(
      "Z",
      { environmentFiles: ["arn:aws:s3:::bucket/file.env"] },
      parent,
    );
    const inline = await resolve(role.inlinePolicies);
    const policy = String(inline?.[0]?.policy);
    expect(policy).toContain("s3:GetObject");
    expect(policy).toContain("bucket/file.env");
  });
});

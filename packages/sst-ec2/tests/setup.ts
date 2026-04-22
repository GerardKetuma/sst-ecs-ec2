import * as pulumi from "@pulumi/pulumi";

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs): {
      id: string;
      state: Record<string, unknown>;
    } {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:ec2/launchTemplate:LaunchTemplate") {
        state.id = `lt-${args.name}`;
        state.latestVersion = 1;
      }
      if (args.type === "aws:autoscaling/group:Group") {
        state.arn = `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:uuid:autoScalingGroupName/${args.name}`;
        state.name = args.name;
      }
      if (args.type === "aws:ecs/cluster:Cluster") {
        state.arn = `arn:aws:ecs:us-east-1:123456789012:cluster/${args.name}`;
        state.name = args.name;
        state.id = args.name;
      }
      if (args.type === "aws:ecs/capacityProvider:CapacityProvider") {
        state.arn = `arn:aws:ecs:us-east-1:123456789012:capacity-provider/${args.name}`;
        state.name = args.name;
      }
      if (args.type === "aws:ecs/taskDefinition:TaskDefinition") {
        state.arn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${args.name}:1`;
      }
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.name}`;
        state.name = args.name;
      }
      if (args.type === "aws:iam/instanceProfile:InstanceProfile") {
        state.arn = `arn:aws:iam::123456789012:instance-profile/${args.name}`;
        state.name = args.name;
      }
      if (args.type === "aws:ecr/repository:Repository") {
        const repoName =
          typeof args.inputs.name === "string" && args.inputs.name.length > 0
            ? args.inputs.name
            : args.name;
        state.arn = `arn:aws:ecr:us-east-1:123456789012:repository/${repoName}`;
        state.name = repoName;
        state.registryId = "123456789012";
        state.repositoryUrl = `123456789012.dkr.ecr.us-east-1.amazonaws.com/${repoName}`;
      }
      if (args.type === "docker-build:index:Image") {
        state.ref = `123456789012.dkr.ecr.us-east-1.amazonaws.com/test:${args.name}@sha256:deadbeef`;
        state.digest = "sha256:deadbeef";
      }
      return { id: `${args.name}-id`, state };
    },
    call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
      if (args.token === "aws:ssm/getParameter:getParameter") {
        return { value: "ami-0123456789abcdef0", version: 1, arn: "arn:ssm:..." };
      }
      if (args.token === "aws:index/getPartition:getPartition") {
        return { partition: "aws" };
      }
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", id: "us-east-1" };
      }
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
        return { accountId: "123456789012", userId: "x", arn: "arn:x" };
      }
      if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken") {
        return {
          authorizationToken: "QVdTOnRva2Vu",
          expiresAt: "2026-01-01T00:00:00Z",
          password: "token",
          proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
          userName: "AWS",
        };
      }
      return {};
    },
  },
  "project",
  "stack",
  false,
);

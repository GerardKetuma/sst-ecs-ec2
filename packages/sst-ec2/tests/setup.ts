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
      return {};
    },
  },
  "project",
  "stack",
  false,
);

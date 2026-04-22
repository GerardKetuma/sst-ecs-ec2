import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type { PermissionStatement, Transform } from "./types.js";
import { applyTransform } from "./transform.js";

const ASSUME_EC2 = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

const ASSUME_ECS_TASKS = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ecs-tasks.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

const SSM_MESSAGES_STATEMENT: PermissionStatement = {
  actions: [
    "ssmmessages:CreateControlChannel",
    "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel",
    "ssmmessages:OpenDataChannel",
  ],
  resources: ["*"],
  effect: "allow",
};

export interface CreateInstanceRoleArgs {
  transform?: Transform<aws.iam.RoleArgs>;
  attachCloudWatchAgentPolicy?: boolean;
}

export function createInstanceRole(
  name: string,
  args: CreateInstanceRoleArgs,
  parent: pulumi.ComponentResource,
): { role: aws.iam.Role; instanceProfile: aws.iam.InstanceProfile } {
  const partition = aws.getPartitionOutput({}, { parent });
  const roleArgs: aws.iam.RoleArgs = {
    assumeRolePolicy: ASSUME_EC2,
    managedPolicyArns: [
      pulumi.interpolate`arn:${partition.partition}:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role`,
      pulumi.interpolate`arn:${partition.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`,
      ...(args.attachCloudWatchAgentPolicy
        ? [pulumi.interpolate`arn:${partition.partition}:iam::aws:policy/CloudWatchAgentServerPolicy`]
        : []),
    ],
  };

  const [roleName, roleFinal, roleOpts] = applyTransform(
    args.transform,
    `${name}InstanceRole`,
    roleArgs,
    { parent },
  );
  const role = new aws.iam.Role(roleName, roleFinal, roleOpts);

  const instanceProfile = new aws.iam.InstanceProfile(
    `${name}InstanceProfile`,
    { role: role.name },
    { parent },
  );

  return { role, instanceProfile };
}

export interface CreateTaskRoleArgs {
  existingRoleArn?: pulumi.Input<string>;
  permissions?: pulumi.Input<PermissionStatement[]>;
  transform?: Transform<aws.iam.RoleArgs>;
}

export function createTaskRole(
  name: string,
  args: CreateTaskRoleArgs,
  parent: pulumi.ComponentResource,
): aws.iam.Role {
  if (args.existingRoleArn) {
    return aws.iam.Role.get(`${name}TaskRole`, args.existingRoleArn, {}, { parent });
  }

  const policy = pulumi.output(args.permissions ?? []).apply((permissions) => {
    const statements: PermissionStatement[] = [...permissions, SSM_MESSAGES_STATEMENT];
    return statementsToPolicyJson(statements);
  });

  const roleArgs: aws.iam.RoleArgs = {
    assumeRolePolicy: ASSUME_ECS_TASKS,
    inlinePolicies: [{ name: "inline", policy }],
  };

  const [roleName, roleFinal, roleOpts] = applyTransform(
    args.transform,
    `${name}TaskRole`,
    roleArgs,
    { parent },
  );
  return new aws.iam.Role(roleName, roleFinal, roleOpts);
}

export interface CreateExecutionRoleArgs {
  existingRoleArn?: pulumi.Input<string>;
  environmentFiles?: pulumi.Input<pulumi.Input<string>[]>;
  secretArns?: pulumi.Input<pulumi.Input<string>[]>;
  transform?: Transform<aws.iam.RoleArgs>;
}

export function createExecutionRole(
  name: string,
  args: CreateExecutionRoleArgs,
  parent: pulumi.ComponentResource,
): aws.iam.Role {
  if (args.existingRoleArn) {
    return aws.iam.Role.get(`${name}ExecutionRole`, args.existingRoleArn, {}, { parent });
  }

  const partition = aws.getPartitionOutput({}, { parent });

  const policy = pulumi
    .all([
      pulumi.output(args.environmentFiles ?? []),
      pulumi.output(args.secretArns ?? []),
    ])
    .apply(([files, secretArns]) => {
      const statements: PermissionStatement[] = [];
      const secretResources = secretArns.length > 0 ? secretArns : ["*"];
      statements.push({
        actions: [
          "ssm:GetParameters",
          "ssm:GetParameter",
          "ssm:GetParameterHistory",
          "secretsmanager:GetSecretValue",
          "kms:Decrypt",
        ],
        resources: secretResources,
        effect: "allow",
      });
      if (files.length > 0) {
        statements.push({
          actions: ["s3:GetObject"],
          resources: files,
          effect: "allow",
        });
      }
      return statementsToPolicyJson(statements);
    });

  const roleArgs: aws.iam.RoleArgs = {
    assumeRolePolicy: ASSUME_ECS_TASKS,
    managedPolicyArns: [
      pulumi.interpolate`arn:${partition.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`,
    ],
    inlinePolicies: [{ name: "inline", policy }],
  };

  const [roleName, roleFinal, roleOpts] = applyTransform(
    args.transform,
    `${name}ExecutionRole`,
    roleArgs,
    { parent },
  );
  return new aws.iam.Role(roleName, roleFinal, roleOpts);
}

function statementsToPolicyJson(statements: PermissionStatement[]): pulumi.Output<string> {
  const mapped = statements.map((s) => ({
    Effect: (s.effect ?? "allow") === "allow" ? "Allow" : "Deny",
    Action: s.actions,
    Resource: s.resources,
  }));
  return pulumi.output(mapped).apply((Statement) =>
    JSON.stringify({ Version: "2012-10-17", Statement }),
  );
}

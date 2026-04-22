import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type {
  Architecture,
  ClusterHandles,
  ContainerArgs,
  HealthCheck,
  Input,
  LinkInclude,
  LinkReceiver,
  NetworkMode,
  PermissionStatement,
  Transform,
  VolumeConfig,
} from "./types.js";
import {
  createExecutionRole,
  createTaskRole,
  type CreateExecutionRoleArgs,
  type CreateTaskRoleArgs,
} from "./iam.js";
import { createTaskDefinition } from "./task-definition.js";
import {
  normalizeArchitecture,
  normalizeCpu,
  normalizeMemory,
  normalizeNetworkMode,
} from "./normalize.js";
import { applyTransform } from "./transform.js";
import {
  buildContainers,
  collectEnvironmentFiles,
  collectSecretArns,
} from "./containers.js";

export interface TaskEc2Transform {
  taskRole?: Transform<aws.iam.RoleArgs>;
  executionRole?: Transform<aws.iam.RoleArgs>;
  taskDefinition?: Transform<aws.ecs.TaskDefinitionArgs>;
  logGroup?: Transform<aws.cloudwatch.LogGroupArgs>;
  publicSecurityGroup?: Transform<aws.ec2.SecurityGroupArgs>;
}

export interface TaskEc2Args {
  cluster: ClusterHandles;

  image?: Input<string>;
  command?: Input<Input<string>[]>;
  entrypoint?: Input<Input<string>[]>;
  environment?: Input<Record<string, Input<string>>>;
  environmentFiles?: Input<Input<string>[]>;
  secrets?: Input<Record<string, Input<string>>>;
  health?: Input<HealthCheck>;
  containers?: ContainerArgs[];

  architecture?: Architecture;
  networkMode?: NetworkMode;
  cpu?: number;
  memory?: number;
  volumes?: VolumeConfig[];

  public?: boolean;

  taskRole?: Input<string>;
  executionRole?: Input<string>;
  permissions?: pulumi.Input<PermissionStatement[]>;

  logRetentionDays?: number;

  transform?: TaskEc2Transform;
}

export class TaskEc2 extends pulumi.ComponentResource {
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly taskRole: aws.iam.Role;
  public readonly executionRole: aws.iam.Role;
  public readonly logGroups: aws.cloudwatch.LogGroup[];
  public readonly publicSecurityGroup?: aws.ec2.SecurityGroup;
  public readonly clusterArn: pulumi.Output<string>;
  public readonly clusterName: pulumi.Output<string>;
  public readonly subnets: pulumi.Output<string[]>;
  public readonly securityGroups: pulumi.Output<string[]>;
  public readonly assignPublicIp: boolean;
  public readonly nodes: {
    taskDefinition: aws.ecs.TaskDefinition;
    taskRole: aws.iam.Role;
    executionRole: aws.iam.Role;
    logGroups: aws.cloudwatch.LogGroup[];
    publicSecurityGroup?: aws.ec2.SecurityGroup;
  };

  constructor(name: string, args: TaskEc2Args, opts?: pulumi.ComponentResourceOptions) {
    super("sst-ec2:aws:TaskEc2", name, {}, opts);

    const architecture = normalizeArchitecture(args.architecture);
    const networkMode = normalizeNetworkMode(args.networkMode);
    const cpu = normalizeCpu(args.cpu);
    const memory = normalizeMemory(args.memory);

    const containers = buildContainers(name, args);

    const taskRoleArgs: CreateTaskRoleArgs = {
      existingRoleArn: args.taskRole,
      permissions: args.permissions,
      transform: args.transform?.taskRole,
    };
    const taskRole = createTaskRole(name, taskRoleArgs, this);

    const execRoleArgs: CreateExecutionRoleArgs = {
      existingRoleArn: args.executionRole,
      environmentFiles: collectEnvironmentFiles(containers),
      secretArns: collectSecretArns(containers),
      transform: args.transform?.executionRole,
    };
    const executionRole = createExecutionRole(name, execRoleArgs, this);

    const { taskDefinition, logGroups } = createTaskDefinition(
      name,
      {
        clusterName: args.cluster.name,
        serviceName: name,
        containers,
        architecture,
        networkMode,
        taskRoleArn: taskRole.arn,
        executionRoleArn: executionRole.arn,
        cpu,
        memory,
        volumes: args.volumes,
        logRetentionDays: args.logRetentionDays,
        transform: args.transform?.taskDefinition,
        transformLogGroup: args.transform?.logGroup,
      },
      this,
    );

    let publicSecurityGroup: aws.ec2.SecurityGroup | undefined;
    if (args.public) {
      const sgArgs: aws.ec2.SecurityGroupArgs = {
        vpcId: args.cluster.vpc.id,
        description: "TaskEc2 public SG",
        ingress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
        egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
      };
      const [sgName, sgFinal, sgOpts] = applyTransform(
        args.transform?.publicSecurityGroup,
        `${name}PublicSecurityGroup`,
        sgArgs,
        { parent: this },
      );
      publicSecurityGroup = new aws.ec2.SecurityGroup(sgName, sgFinal, sgOpts);
    }

    this.taskDefinition = taskDefinition;
    this.taskRole = taskRole;
    this.executionRole = executionRole;
    this.logGroups = logGroups;
    this.publicSecurityGroup = publicSecurityGroup;
    this.clusterArn = pulumi.output(args.cluster.arn);
    this.clusterName = pulumi.output(args.cluster.name);
    this.subnets = publicSecurityGroup
      ? pulumi.output(args.cluster.vpc.publicSubnets ?? args.cluster.vpc.containerSubnets)
      : pulumi.output(args.cluster.vpc.containerSubnets);
    this.securityGroups = publicSecurityGroup
      ? pulumi.all([publicSecurityGroup.id]).apply((ids) => [...ids])
      : pulumi.output(args.cluster.vpc.securityGroups);
    this.assignPublicIp = publicSecurityGroup !== undefined;
    this.nodes = {
      taskDefinition,
      taskRole,
      executionRole,
      logGroups,
      publicSecurityGroup,
    };

    this.registerOutputs({
      taskDefinitionArn: taskDefinition.arn,
      clusterArn: this.clusterArn,
    });
  }

  getSSTLink(): LinkReceiver {
    const properties: Record<string, Input<string>> = {
      clusterArn: this.clusterArn,
      clusterName: this.clusterName,
      taskDefinitionArn: this.taskDefinition.arn,
      assignPublicIp: this.assignPublicIp ? "true" : "false",
      subnets: this.subnets.apply((s) => s.join(",")),
      securityGroups: this.securityGroups.apply((s) => s.join(",")),
    };
    const include: LinkInclude[] = [
      {
        type: "aws.permission",
        actions: ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"],
        resources: pulumi.all([this.taskDefinition.arn]).apply((arns) => [...arns]),
      },
      {
        type: "aws.permission",
        actions: ["iam:PassRole"],
        resources: pulumi
          .all([this.taskRole.arn, this.executionRole.arn])
          .apply((arns) => [...arns]),
      },
    ];
    return { properties, include };
  }
}

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type {
  Architecture,
  ClusterHandles,
  ContainerArgs,
  ContainerImage,
  HealthCheck,
  Input,
  LinkInclude,
  LinkReceiver,
  NetworkMode,
  PermissionStatement,
  Transform,
  VolumeConfig,
} from "./types.js";
import type { ImageBuildContext } from "./image-builder.js";
import {
  createExecutionRole,
  createTaskRole,
  type CreateExecutionRoleArgs,
  type CreateTaskRoleArgs,
} from "./iam.js";
import { createTaskDefinition } from "./task-definition.js";
import {
  createLoadBalancer,
  parsePortString,
  type CreateLoadBalancerResult,
  type LoadBalancerArgs,
} from "./load-balancer.js";
import { applyTransform } from "./transform.js";
import {
  normalizeArchitecture,
  normalizeCpu,
  normalizeMemory,
  normalizeNetworkMode,
} from "./normalize.js";
import {
  buildContainers,
  collectEnvironmentFiles,
  collectSecretArns,
  firstContainerName,
} from "./containers.js";

export interface ServiceEc2Scaling {
  min?: number;
  max?: number;
  cpuUtilization?: number | false;
  memoryUtilization?: number | false;
  requestCount?: number | false;
  scaleOutCooldown?: number;
  scaleInCooldown?: number;
}

export interface PlacementStrategy {
  type: "binpack" | "spread" | "random";
  field?: string;
}

export interface PlacementConstraint {
  type: "distinctInstance" | "memberOf";
  expression?: string;
}

export interface ServiceEc2Placement {
  strategies?: PlacementStrategy[];
  constraints?: PlacementConstraint[];
}

export interface CapacityProviderStrategyItem {
  capacityProvider: Input<string>;
  base?: number;
  weight?: number;
}

export interface ServiceRegistryArgs {
  port: number;
  containerName?: string;
}

export interface ServiceEc2Transform {
  taskRole?: Transform<aws.iam.RoleArgs>;
  executionRole?: Transform<aws.iam.RoleArgs>;
  taskDefinition?: Transform<aws.ecs.TaskDefinitionArgs>;
  service?: Transform<aws.ecs.ServiceArgs>;
  logGroup?: Transform<aws.cloudwatch.LogGroupArgs>;
  cloudmapService?: Transform<aws.servicediscovery.ServiceArgs>;
  loadBalancer?: Transform<aws.lb.LoadBalancerArgs>;
  loadBalancerSecurityGroup?: Transform<aws.ec2.SecurityGroupArgs>;
  targetGroup?: Transform<aws.lb.TargetGroupArgs>;
  listener?: Transform<aws.lb.ListenerArgs>;
  dnsRecord?: Transform<aws.route53.RecordArgs>;
  autoScalingTarget?: Transform<aws.appautoscaling.TargetArgs>;
}

export interface ServiceEc2Args {
  cluster: ClusterHandles;

  image?: ContainerImage;
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

  scaling?: ServiceEc2Scaling;
  loadBalancer?: LoadBalancerArgs;
  serviceRegistry?: ServiceRegistryArgs;
  placement?: ServiceEc2Placement;
  capacityProviderStrategy?: CapacityProviderStrategyItem[];

  wait?: boolean;
  enableExecuteCommand?: boolean;

  /**
   * Override the cluster-provided image build context.
   * Useful when you want to force a build spec on a cluster referenced via
   * `ClusterEc2.get()` (which has no attached ECR repo).
   */
  imageBuildContext?: ImageBuildContext;

  taskRole?: Input<string>;
  executionRole?: Input<string>;
  permissions?: pulumi.Input<PermissionStatement[]>;

  logRetentionDays?: number;

  transform?: ServiceEc2Transform;
}

export class ServiceEc2 extends pulumi.ComponentResource {
  public readonly service: aws.ecs.Service;
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly taskRole: aws.iam.Role;
  public readonly executionRole: aws.iam.Role;
  public readonly logGroups: aws.cloudwatch.LogGroup[];
  public readonly loadBalancer?: aws.lb.LoadBalancer;
  public readonly cloudmapService?: aws.servicediscovery.Service;
  public readonly url?: pulumi.Output<string>;
  public readonly nodes: {
    service: aws.ecs.Service;
    taskDefinition: aws.ecs.TaskDefinition;
    taskRole: aws.iam.Role;
    executionRole: aws.iam.Role;
    logGroups: aws.cloudwatch.LogGroup[];
    loadBalancer?: CreateLoadBalancerResult;
    cloudmapService?: aws.servicediscovery.Service;
    autoScalingTarget?: aws.appautoscaling.Target;
    autoScalingPolicies: aws.appautoscaling.Policy[];
  };

  constructor(name: string, args: ServiceEc2Args, opts?: pulumi.ComponentResourceOptions) {
    super("sst-ec2:aws:ServiceEc2", name, {}, opts);

    const architecture = normalizeArchitecture(args.architecture);
    const networkMode = normalizeNetworkMode(args.networkMode);
    const cpu = normalizeCpu(args.cpu);
    const memory = normalizeMemory(args.memory);

    const portMappings = args.loadBalancer
      ? args.loadBalancer.ports.map((p) => {
          const parsed = parsePortString(p.forward ?? p.listen);
          return { containerPort: parsed.port, protocol: "tcp" as const };
        })
      : undefined;
    const imageBuildContext =
      args.imageBuildContext ?? deriveImageBuildContext(args.cluster, architecture, this);
    const containers = buildContainers(name, args, { portMappings, imageBuildContext });

    const scaling = normalizeScaling(args.scaling);

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

    let lbResult: CreateLoadBalancerResult | undefined;
    let lbScheme: "http" | "https" = "http";
    if (args.loadBalancer) {
      const lbArgs: LoadBalancerArgs = {
        ...args.loadBalancer,
        transform: {
          ...args.loadBalancer.transform,
          loadBalancer: args.transform?.loadBalancer ?? args.loadBalancer.transform?.loadBalancer,
          loadBalancerSecurityGroup:
            args.transform?.loadBalancerSecurityGroup ??
            args.loadBalancer.transform?.loadBalancerSecurityGroup,
          targetGroup: args.transform?.targetGroup ?? args.loadBalancer.transform?.targetGroup,
          listener: args.transform?.listener ?? args.loadBalancer.transform?.listener,
          dnsRecord: args.transform?.dnsRecord ?? args.loadBalancer.transform?.dnsRecord,
        },
      };
      lbResult = createLoadBalancer(name, lbArgs, args.cluster.vpc, this);
      const anyHttps = args.loadBalancer.ports.some(
        (p) => parsePortString(p.listen).protocol === "https",
      );
      lbScheme = anyHttps ? "https" : "http";
    }

    const serviceLoadBalancers = lbResult
      ? lbResult.targetEntries.map((entry) => {
          const tgKey = `${entry.forward.port}-${entry.forward.protocol}`;
          const tg = lbResult.targetGroups.get(tgKey);
          if (!tg) {
            throw new Error(`Missing target group for ${tgKey}`);
          }
          const containerName = entry.containerName ?? firstContainerName(containers);
          return {
            targetGroupArn: tg.arn,
            containerName,
            containerPort: entry.forward.port,
          };
        })
      : undefined;

    const capacityProviderStrategies =
      args.capacityProviderStrategy && args.capacityProviderStrategy.length > 0
        ? args.capacityProviderStrategy.map((s) => ({
            capacityProvider: s.capacityProvider,
            base: s.base ?? 0,
            weight: s.weight ?? 1,
          }))
        : [
            {
              capacityProvider: args.cluster.capacityProviderName,
              base: 0,
              weight: 100,
            },
          ];

    const placement = args.placement ?? {
      strategies: [
        { type: "spread", field: "attribute:ecs.availability-zone" },
        { type: "binpack", field: "memory" },
      ],
    };

    let cloudmapService: aws.servicediscovery.Service | undefined;
    let serviceRegistries: aws.types.input.ecs.ServiceServiceRegistries | undefined;
    if (args.serviceRegistry) {
      if (!args.cluster.vpc.cloudmapNamespaceId) {
        throw new Error(
          "`serviceRegistry` requires `vpc.cloudmapNamespaceId` to be set on the cluster's VPC",
        );
      }
      const cmArgs: aws.servicediscovery.ServiceArgs = {
        name,
        dnsConfig: {
          namespaceId: args.cluster.vpc.cloudmapNamespaceId,
          dnsRecords: [
            { type: "A", ttl: 60 },
            { type: "SRV", ttl: 60 },
          ],
          routingPolicy: "MULTIVALUE",
        },
        healthCheckCustomConfig: { failureThreshold: 1 },
      };
      const [cmName, cmFinal, cmOpts] = applyTransform(
        args.transform?.cloudmapService,
        `${name}CloudmapService`,
        cmArgs,
        { parent: this },
      );
      cloudmapService = new aws.servicediscovery.Service(cmName, cmFinal, cmOpts);
      serviceRegistries = {
        registryArn: cloudmapService.arn,
        port: args.serviceRegistry.port,
        containerName: args.serviceRegistry.containerName ?? firstContainerName(containers),
        containerPort: args.serviceRegistry.port,
      };
    }

    const serviceArgs: aws.ecs.ServiceArgs = {
      name,
      cluster: args.cluster.arn,
      taskDefinition: taskDefinition.arn,
      desiredCount: scaling.min,
      capacityProviderStrategies,
      deploymentCircuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: args.enableExecuteCommand ?? true,
      forceNewDeployment: true,
      waitForSteadyState: args.wait ?? false,
      propagateTags: "TASK_DEFINITION",
      ...(networkMode === "awsvpc"
        ? {
            networkConfiguration: {
              assignPublicIp: false,
              subnets: args.cluster.vpc.containerSubnets,
              securityGroups: args.cluster.vpc.securityGroups,
            },
          }
        : {}),
      ...(serviceLoadBalancers ? { loadBalancers: serviceLoadBalancers } : {}),
      ...(serviceRegistries ? { serviceRegistries } : {}),
      orderedPlacementStrategies:
        placement.strategies?.map((s) => ({ type: s.type, field: s.field })) ?? [],
      placementConstraints:
        placement.constraints?.map((c) => ({ type: c.type, expression: c.expression })) ?? [],
    };

    const ccp = args.cluster.nodes.clusterCapacityProviders;
    const serviceOpts: pulumi.CustomResourceOptions = {
      parent: this,
      dependsOn: ccp ? [ccp] : [],
    };
    const [svcName, svcFinal, svcOpts] = applyTransform(
      args.transform?.service,
      `${name}Service`,
      serviceArgs,
      serviceOpts,
    );
    const service = new aws.ecs.Service(svcName, svcFinal, svcOpts);

    const autoScalingPolicies: aws.appautoscaling.Policy[] = [];
    let autoScalingTarget: aws.appautoscaling.Target | undefined;
    if (scaling.max > scaling.min) {
      const targetArgs: aws.appautoscaling.TargetArgs = {
        serviceNamespace: "ecs",
        scalableDimension: "ecs:service:DesiredCount",
        resourceId: pulumi.interpolate`service/${args.cluster.name}/${service.name}`,
        minCapacity: scaling.min,
        maxCapacity: scaling.max,
      };
      const [tName, tFinal, tOpts] = applyTransform(
        args.transform?.autoScalingTarget,
        `${name}AutoScalingTarget`,
        targetArgs,
        { parent: this },
      );
      autoScalingTarget = new aws.appautoscaling.Target(tName, tFinal, tOpts);

      if (scaling.cpuUtilization !== false) {
        autoScalingPolicies.push(
          new aws.appautoscaling.Policy(
            `${name}AutoScalingCpuPolicy`,
            {
              policyType: "TargetTrackingScaling",
              resourceId: autoScalingTarget.resourceId,
              scalableDimension: autoScalingTarget.scalableDimension,
              serviceNamespace: autoScalingTarget.serviceNamespace,
              targetTrackingScalingPolicyConfiguration: {
                targetValue: scaling.cpuUtilization,
                predefinedMetricSpecification: {
                  predefinedMetricType: "ECSServiceAverageCPUUtilization",
                },
                scaleInCooldown: scaling.scaleInCooldown,
                scaleOutCooldown: scaling.scaleOutCooldown,
              },
            },
            { parent: this },
          ),
        );
      }

      if (scaling.memoryUtilization !== false) {
        autoScalingPolicies.push(
          new aws.appautoscaling.Policy(
            `${name}AutoScalingMemoryPolicy`,
            {
              policyType: "TargetTrackingScaling",
              resourceId: autoScalingTarget.resourceId,
              scalableDimension: autoScalingTarget.scalableDimension,
              serviceNamespace: autoScalingTarget.serviceNamespace,
              targetTrackingScalingPolicyConfiguration: {
                targetValue: scaling.memoryUtilization,
                predefinedMetricSpecification: {
                  predefinedMetricType: "ECSServiceAverageMemoryUtilization",
                },
                scaleInCooldown: scaling.scaleInCooldown,
                scaleOutCooldown: scaling.scaleOutCooldown,
              },
            },
            { parent: this },
          ),
        );
      }

      if (scaling.requestCount !== false && lbResult && lbResult.targetGroups.size > 0) {
        const firstTg = [...lbResult.targetGroups.values()][0];
        if (firstTg) {
          const resourceLabel = pulumi.interpolate`${lbResult.loadBalancer.arnSuffix}/${firstTg.arnSuffix}`;
          autoScalingPolicies.push(
            new aws.appautoscaling.Policy(
              `${name}AutoScalingRequestCountPolicy`,
              {
                policyType: "TargetTrackingScaling",
                resourceId: autoScalingTarget.resourceId,
                scalableDimension: autoScalingTarget.scalableDimension,
                serviceNamespace: autoScalingTarget.serviceNamespace,
                targetTrackingScalingPolicyConfiguration: {
                  targetValue: scaling.requestCount,
                  predefinedMetricSpecification: {
                    predefinedMetricType: "ALBRequestCountPerTarget",
                    resourceLabel,
                  },
                  scaleInCooldown: scaling.scaleInCooldown,
                  scaleOutCooldown: scaling.scaleOutCooldown,
                },
              },
              { parent: this },
            ),
          );
        }
      }
    }

    this.service = service;
    this.taskDefinition = taskDefinition;
    this.taskRole = taskRole;
    this.executionRole = executionRole;
    this.logGroups = logGroups;
    this.loadBalancer = lbResult?.loadBalancer;
    this.cloudmapService = cloudmapService;
    this.url = lbResult
      ? pulumi.interpolate`${lbScheme}://${lbResult.loadBalancer.dnsName}`
      : undefined;
    this.nodes = {
      service,
      taskDefinition,
      taskRole,
      executionRole,
      logGroups,
      loadBalancer: lbResult,
      cloudmapService,
      autoScalingTarget,
      autoScalingPolicies,
    };

    this.registerOutputs({
      service: service.id,
      taskDefinition: taskDefinition.arn,
      url: this.url,
    });
  }

  getSSTLink(): LinkReceiver {
    const properties: Record<string, Input<string>> = {
      serviceName: this.service.name,
      clusterArn: pulumi.output(this.service.cluster),
      taskDefinitionArn: this.taskDefinition.arn,
    };
    if (this.url) properties.url = this.url;
    const include: LinkInclude[] = [
      {
        type: "aws.permission",
        actions: [
          "ecs:DescribeServices",
          "ecs:UpdateService",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ],
        resources: pulumi.all([this.service.id]).apply((ids) => [...ids]),
      },
    ];
    return { properties, include };
  }
}

interface NormalizedScaling {
  min: number;
  max: number;
  cpuUtilization: number | false;
  memoryUtilization: number | false;
  requestCount: number | false;
  scaleOutCooldown: number;
  scaleInCooldown: number;
}

function normalizeScaling(s: ServiceEc2Scaling | undefined): NormalizedScaling {
  const min = s?.min ?? 1;
  const max = s?.max ?? min;
  if (max < min) throw new Error("scaling.max must be >= scaling.min");
  return {
    min,
    max,
    cpuUtilization: s?.cpuUtilization === false ? false : (s?.cpuUtilization ?? 70),
    memoryUtilization: s?.memoryUtilization === false ? false : (s?.memoryUtilization ?? 70),
    requestCount: s?.requestCount === false || s?.requestCount === undefined ? false : s.requestCount,
    scaleOutCooldown: s?.scaleOutCooldown ?? 300,
    scaleInCooldown: s?.scaleInCooldown ?? 300,
  };
}

function deriveImageBuildContext(
  cluster: ClusterHandles,
  architecture: Architecture,
  parent: pulumi.ComponentResource,
): ImageBuildContext | undefined {
  if (!cluster.imageRepository) return undefined;
  return {
    repository: cluster.imageRepository.repository,
    authToken: cluster.imageRepository.authToken,
    architecture: cluster.architecture ?? architecture,
    parent,
  };
}

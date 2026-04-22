import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type {
  Architecture,
  ContainerArgs,
  NetworkMode,
  Transform,
  VolumeConfig,
} from "./types.js";
import { applyTransform } from "./transform.js";
import { archToEcsToken } from "./normalize.js";

interface RenderedEnvEntry {
  name: string;
  value: string;
}

interface RenderedEnvFile {
  type: "s3";
  value: string;
}

interface RenderedSecret {
  name: string;
  valueFrom: string;
}

interface RenderedPortMapping {
  containerPort: number;
  hostPort?: number;
  protocol: "tcp" | "udp";
}

interface RenderedMountPoint {
  sourceVolume: string;
  containerPath: string;
  readOnly: boolean;
}

interface RenderedHealthCheck {
  command: string[];
  startPeriod?: number;
  timeout?: number;
  interval?: number;
  retries?: number;
}

interface RenderedLogConfig {
  logDriver: "awslogs";
  options: Record<string, string>;
}

interface RenderedDependsOn {
  containerName: string;
  condition: "START" | "COMPLETE" | "SUCCESS" | "HEALTHY";
}

interface RenderedContainerDefinition {
  name: string;
  image: string;
  cpu?: number;
  memory?: number;
  memoryReservation?: number;
  essential: boolean;
  command?: string[];
  entryPoint?: string[];
  environment?: RenderedEnvEntry[];
  environmentFiles?: RenderedEnvFile[];
  secrets?: RenderedSecret[];
  portMappings?: RenderedPortMapping[];
  mountPoints?: RenderedMountPoint[];
  logConfiguration?: RenderedLogConfig;
  healthCheck?: RenderedHealthCheck;
  user?: string;
  workingDirectory?: string;
  dependsOn?: RenderedDependsOn[];
}

interface ResolvedContainer {
  name: string;
  image: string;
  cpu?: number;
  memory?: number;
  memoryReservation?: number;
  essential?: boolean;
  command?: string[];
  entrypoint?: string[];
  environment?: Record<string, string>;
  environmentFiles?: string[];
  secrets?: Record<string, string>;
  portMappings?: { containerPort: number; hostPort?: number; protocol?: "tcp" | "udp" }[];
  volumes?: { path: string; efs: { fileSystem: string; accessPoint: string } }[];
  health?: {
    command: string[];
    startPeriod?: number;
    timeout?: number;
    interval?: number;
    retries?: number;
  };
  user?: string;
  workingDirectory?: string;
  dependsOn?: { containerName: string; condition: "START" | "COMPLETE" | "SUCCESS" | "HEALTHY" }[];
}

export interface CreateTaskDefinitionArgs {
  clusterName: pulumi.Input<string>;
  serviceName: string;
  containers: ContainerArgs[];
  architecture: Architecture;
  networkMode: NetworkMode;
  taskRoleArn: pulumi.Input<string>;
  executionRoleArn: pulumi.Input<string>;
  cpu?: number;
  memory?: number;
  volumes?: VolumeConfig[];
  logRetentionDays?: number;
  transform?: Transform<aws.ecs.TaskDefinitionArgs>;
  transformLogGroup?: Transform<aws.cloudwatch.LogGroupArgs>;
}

export function createTaskDefinition(
  name: string,
  args: CreateTaskDefinitionArgs,
  parent: pulumi.ComponentResource,
): { taskDefinition: aws.ecs.TaskDefinition; logGroups: aws.cloudwatch.LogGroup[] } {
  const logGroups: aws.cloudwatch.LogGroup[] = [];

  const regionInfo = aws.getRegionOutput({}, { parent });
  const region = regionInfo.name;
  const retentionDays = args.logRetentionDays ?? 30;

  const containerOutputs = args.containers.map((container, idx) => {
    const logGroupName = pulumi.interpolate`/sst-ec2/${args.clusterName}/${args.serviceName}/${container.name}`;
    const logGroupKey = safeLogKey(staticNameHint(container.name, idx));

    const lgArgs: aws.cloudwatch.LogGroupArgs = {
      name: logGroupName,
      retentionInDays: retentionDays,
    };
    const [lgName, lgFinal, lgOpts] = applyTransform(
      args.transformLogGroup,
      `${name}LogGroup${logGroupKey}`,
      lgArgs,
      { parent },
    );
    const logGroup = new aws.cloudwatch.LogGroup(lgName, lgFinal, lgOpts);
    logGroups.push(logGroup);

    return renderContainer(container, logGroupName, region, args.networkMode);
  });

  const containerDefinitions = pulumi
    .all(containerOutputs)
    .apply((rendered) => JSON.stringify(rendered));

  const volumesArgs = args.volumes ? renderVolumes(args.volumes) : undefined;

  const taskDefArgs: aws.ecs.TaskDefinitionArgs = {
    family: pulumi.interpolate`${args.clusterName}-${args.serviceName}`,
    requiresCompatibilities: ["EC2"],
    networkMode: args.networkMode,
    executionRoleArn: args.executionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions,
    runtimePlatform: {
      cpuArchitecture: archToEcsToken(args.architecture),
      operatingSystemFamily: "LINUX",
    },
    ...(typeof args.cpu === "number" ? { cpu: String(args.cpu) } : {}),
    ...(typeof args.memory === "number" ? { memory: String(args.memory) } : {}),
    ...(volumesArgs ? { volumes: volumesArgs } : {}),
  };

  const [tdName, tdFinal, tdOpts] = applyTransform(
    args.transform,
    `${name}TaskDefinition`,
    taskDefArgs,
    { parent },
  );
  const taskDefinition = new aws.ecs.TaskDefinition(tdName, tdFinal, tdOpts);

  return { taskDefinition, logGroups };
}

function renderContainer(
  container: ContainerArgs,
  logGroupName: pulumi.Output<string>,
  region: pulumi.Output<string>,
  networkMode: NetworkMode,
): pulumi.Output<RenderedContainerDefinition> {
  // Cast narrows the broad `Unwrap<...>` union that `pulumi.output` infers for an
  // object with many optional Input<T> fields to our hand-written ResolvedContainer.
  // The structural shape matches exactly; Pulumi's inferred union just loses literal
  // types (e.g. `"tcp" | "udp"` becomes `string`).
  const resolved: pulumi.Output<ResolvedContainer> = pulumi.output({
    name: container.name,
    image: container.image,
    cpu: container.cpu,
    memory: container.memory,
    memoryReservation: container.memoryReservation,
    essential: container.essential,
    command: container.command,
    entrypoint: container.entrypoint,
    environment: container.environment,
    environmentFiles: container.environmentFiles,
    secrets: container.secrets,
    portMappings: container.portMappings,
    volumes: container.volumes,
    health: container.health,
    user: container.user,
    workingDirectory: container.workingDirectory,
    dependsOn: container.dependsOn,
  }) as pulumi.Output<ResolvedContainer>;

  return pulumi
    .all([resolved, logGroupName, region])
    .apply(([c, groupName, regionName]): RenderedContainerDefinition => {
      const def: RenderedContainerDefinition = {
        name: c.name,
        image: c.image,
        essential: c.essential ?? true,
      };

      if (typeof c.cpu === "number") def.cpu = c.cpu;
      if (typeof c.memory === "number") def.memory = c.memory;
      if (typeof c.memoryReservation === "number") def.memoryReservation = c.memoryReservation;
      if (c.command && c.command.length > 0) def.command = [...c.command];
      if (c.entrypoint && c.entrypoint.length > 0) def.entryPoint = [...c.entrypoint];

      if (c.environment) {
        def.environment = Object.entries(c.environment).map(([k, v]) => ({ name: k, value: v }));
      }

      if (c.environmentFiles && c.environmentFiles.length > 0) {
        def.environmentFiles = c.environmentFiles.map((arn) => ({ type: "s3", value: arn }));
      }

      if (c.secrets) {
        def.secrets = Object.entries(c.secrets).map(([k, v]) => ({ name: k, valueFrom: v }));
      }

      if (c.portMappings && c.portMappings.length > 0) {
        def.portMappings = c.portMappings.map((pm): RenderedPortMapping => {
          const protocol: "tcp" | "udp" = pm.protocol ?? "tcp";
          if (networkMode === "awsvpc" || networkMode === "host") {
            return { containerPort: pm.containerPort, protocol };
          }
          return {
            containerPort: pm.containerPort,
            hostPort: typeof pm.hostPort === "number" ? pm.hostPort : 0,
            protocol,
          };
        });
      }

      if (c.volumes && c.volumes.length > 0) {
        def.mountPoints = c.volumes.map((v) => ({
          sourceVolume: resolvedVolumeName(v.path),
          containerPath: v.path,
          readOnly: false,
        }));
      }

      def.logConfiguration = {
        logDriver: "awslogs",
        options: {
          "awslogs-group": groupName,
          "awslogs-region": regionName,
          "awslogs-stream-prefix": c.name,
        },
      };

      if (c.health) {
        const h = c.health;
        const hc: RenderedHealthCheck = { command: [...h.command] };
        if (typeof h.startPeriod === "number") hc.startPeriod = h.startPeriod;
        if (typeof h.timeout === "number") hc.timeout = h.timeout;
        if (typeof h.interval === "number") hc.interval = h.interval;
        if (typeof h.retries === "number") hc.retries = h.retries;
        def.healthCheck = hc;
      }

      if (c.user) def.user = c.user;
      if (c.workingDirectory) def.workingDirectory = c.workingDirectory;

      if (c.dependsOn && c.dependsOn.length > 0) {
        def.dependsOn = c.dependsOn.map((d) => ({
          containerName: d.containerName,
          condition: d.condition,
        }));
      }

      return def;
    });
}

function renderVolumes(
  volumes: VolumeConfig[],
): pulumi.Output<aws.types.input.ecs.TaskDefinitionVolume[]> {
  const resolved = volumes.map((v) =>
    pulumi.output({ efs: v.efs, path: v.path }).apply(
      ({ efs, path }): aws.types.input.ecs.TaskDefinitionVolume => ({
        name: resolvedVolumeName(path),
        efsVolumeConfiguration: {
          fileSystemId: efs.fileSystem,
          transitEncryption: "ENABLED",
          authorizationConfig: { accessPointId: efs.accessPoint, iam: "ENABLED" },
        },
      }),
    ),
  );
  return pulumi.all(resolved);
}

function resolvedVolumeName(path: string): string {
  const cleaned = path.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "").slice(0, 60);
  return `efs-${cleaned || "root"}`;
}

function staticNameHint(name: ContainerArgs["name"], idx: number): string {
  return typeof name === "string" ? name : `c${idx}`;
}

function safeLogKey(n: string): string {
  return n.replace(/[^A-Za-z0-9]/g, "") || "Container";
}

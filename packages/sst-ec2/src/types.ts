import type * as pulumi from "@pulumi/pulumi";
import type * as aws from "@pulumi/aws";

export type Transform<T extends object> =
  | Partial<T>
  | ((args: T, opts: pulumi.CustomResourceOptions, name: string) => void);

export type Input<T> = pulumi.Input<T>;

export interface VpcShape {
  id: Input<string>;
  securityGroups: Input<Input<string>[]>;
  containerSubnets: Input<Input<string>[]>;
  loadBalancerSubnets?: Input<Input<string>[]>;
  publicSubnets?: Input<Input<string>[]>;
  cloudmapNamespaceId?: Input<string>;
  cloudmapNamespaceName?: Input<string>;
}

export interface LogConfig {
  retention?: Input<number>;
  name?: Input<string>;
}

export interface VolumeConfig {
  path: Input<string>;
  efs: Input<{
    fileSystem: Input<string>;
    accessPoint: Input<string>;
  }>;
}

export interface HealthCheck {
  command: Input<Input<string>[]>;
  startPeriod?: Input<number>;
  timeout?: Input<number>;
  interval?: Input<number>;
  retries?: Input<number>;
}

export type ContainerImage = Input<string> | ContainerImageBuildSpec;

export interface ContainerImageBuildSpec {
  context: Input<string>;
  dockerfile?: Input<string>;
  args?: Input<Record<string, Input<string>>>;
  target?: Input<string>;
  platform?: Input<string>;
}

export interface ContainerArgs {
  name: Input<string>;
  image: ContainerImage;
  cpu?: Input<number>;
  memory?: Input<number>;
  memoryReservation?: Input<number>;
  essential?: Input<boolean>;
  command?: Input<Input<string>[]>;
  entrypoint?: Input<Input<string>[]>;
  environment?: Input<Record<string, Input<string>>>;
  environmentFiles?: Input<Input<string>[]>;
  secrets?: Input<Record<string, Input<string>>>;
  portMappings?: Input<
    Input<{
      containerPort: Input<number>;
      hostPort?: Input<number>;
      protocol?: Input<"tcp" | "udp">;
    }>[]
  >;
  logging?: Input<LogConfig>;
  volumes?: Input<Input<VolumeConfig>[]>;
  health?: Input<HealthCheck>;
  dependsOn?: Input<
    Input<{
      containerName: Input<string>;
      condition: Input<"START" | "COMPLETE" | "SUCCESS" | "HEALTHY">;
    }>[]
  >;
  user?: Input<string>;
  workingDirectory?: Input<string>;
}

export type Architecture = "x86_64" | "arm64";

export type NetworkMode = "awsvpc" | "bridge" | "host";

export type BottlerocketVariant = "aws-ecs-1" | "aws-ecs-2";

export interface PermissionStatement {
  actions: Input<Input<string>[]>;
  resources: Input<Input<string>[]>;
  effect?: Input<"allow" | "deny">;
}

export interface LinkReceiver {
  properties: Record<string, Input<string>>;
  include?: LinkInclude[];
}

export interface LinkInclude {
  type: string;
  actions?: Input<string[]>;
  resources?: Input<Input<string>[]>;
}

export interface ClusterHandles {
  id: Input<string>;
  arn: Input<string>;
  name: Input<string>;
  capacityProviderName: Input<string>;
  vpc: VpcShape;
  architecture?: Architecture;
  imageRepository?: {
    repository: aws.ecr.Repository;
    authToken: pulumi.Output<aws.ecr.GetAuthorizationTokenResult>;
  };
  nodes: {
    cluster: aws.ecs.Cluster;
    clusterCapacityProviders?: aws.ecs.ClusterCapacityProviders;
    repository?: aws.ecr.Repository;
  };
}

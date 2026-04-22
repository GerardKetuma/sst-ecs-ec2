import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type {
  Architecture,
  BottlerocketVariant,
  ClusterHandles,
  Input,
  Transform,
  VpcShape,
} from "./types.js";
import type { BottlerocketSettings } from "./bottlerocket.js";
import {
  attachCapacityProviderToCluster,
  createAsg,
  createCapacityProvider,
  createLaunchTemplate,
  defaultInstanceType,
  enableAwsvpcTrunking,
  type SpotConfig,
} from "./capacity.js";
import { createInstanceRole } from "./iam.js";
import { applyTransform } from "./transform.js";
import { normalizeArchitecture, normalizeVariant } from "./normalize.js";

export interface ClusterEc2Capacity {
  min?: number;
  max?: number;
  desired?: number;
  targetCapacity?: number;
  warmup?: number;
}

export interface ClusterEc2Spot {
  onDemandBase?: number;
  onDemandPercentageAboveBase?: number;
  instanceTypes?: string[];
}

export interface ClusterEc2Debug {
  enableAdminContainer?: boolean;
}

export interface ClusterEc2Transform {
  cluster?: Transform<aws.ecs.ClusterArgs>;
  clusterCapacityProviders?: Transform<aws.ecs.ClusterCapacityProvidersArgs>;
  capacityProvider?: Transform<aws.ecs.CapacityProviderArgs>;
  launchTemplate?: Transform<aws.ec2.LaunchTemplateArgs>;
  autoScalingGroup?: Transform<aws.autoscaling.GroupArgs>;
  instanceRole?: Transform<aws.iam.RoleArgs>;
  repository?: Transform<aws.ecr.RepositoryArgs>;
  userDataToml?: (settings: BottlerocketSettings) => BottlerocketSettings;
}

export interface ClusterEc2Args {
  vpc: VpcShape;
  variant?: BottlerocketVariant;
  architecture?: Architecture;
  amiVersion?: string;
  instanceType?: string;
  rootVolumeSize?: number;
  capacity?: ClusterEc2Capacity;
  spot?: ClusterEc2Spot;
  containerInsights?: boolean | "enhanced";
  enableTrunking?: boolean;
  debug?: ClusterEc2Debug;
  transform?: ClusterEc2Transform;
}

export interface ClusterEc2GetArgs {
  clusterName: Input<string>;
  capacityProviderName: Input<string>;
  vpc: VpcShape;
  architecture?: Architecture;
}

export class ClusterEc2 extends pulumi.ComponentResource implements ClusterHandles {
  public readonly id: pulumi.Output<string>;
  public readonly arn: pulumi.Output<string>;
  public readonly name: pulumi.Output<string>;
  public readonly capacityProviderName: pulumi.Output<string>;
  public readonly vpc: VpcShape;
  public readonly architecture: Architecture;
  public readonly imageRepository: {
    repository: aws.ecr.Repository;
    authToken: pulumi.Output<aws.ecr.GetAuthorizationTokenResult>;
  };
  public readonly nodes: {
    cluster: aws.ecs.Cluster;
    launchTemplate?: aws.ec2.LaunchTemplate;
    autoScalingGroup?: aws.autoscaling.Group;
    capacityProvider?: aws.ecs.CapacityProvider;
    clusterCapacityProviders?: aws.ecs.ClusterCapacityProviders;
    instanceRole?: aws.iam.Role;
    instanceProfile?: aws.iam.InstanceProfile;
    trunking?: aws.ecs.AccountSettingDefault;
    repository?: aws.ecr.Repository;
  };

  constructor(name: string, args: ClusterEc2Args, opts?: pulumi.ComponentResourceOptions) {
    super("sst-ec2:aws:ClusterEc2", name, {}, opts);

    const architecture = normalizeArchitecture(args.architecture);
    const variant = normalizeVariant(args.variant);
    const amiVersion = args.amiVersion ?? "latest";
    const instanceType = args.instanceType ?? defaultInstanceType(architecture);
    const rootVolumeSize = args.rootVolumeSize ?? 30;

    const cap = args.capacity ?? {};
    const minSize = cap.min ?? 1;
    const maxSize = cap.max ?? 10;
    const desired = cap.desired ?? minSize;
    const targetCapacity = cap.targetCapacity ?? 80;
    const warmup = cap.warmup ?? 90;

    const containerInsightsValue = normalizeContainerInsights(args.containerInsights);
    const enableTrunking = args.enableTrunking ?? true;
    const enableAdminContainer = args.debug?.enableAdminContainer ?? false;

    const spot = normalizeSpot(args.spot, instanceType);

    if (minSize < 0) throw new Error("capacity.min must be >= 0");
    if (maxSize < minSize) throw new Error("capacity.max must be >= capacity.min");
    if (desired < minSize || desired > maxSize) {
      throw new Error("capacity.desired must be between capacity.min and capacity.max");
    }
    if (targetCapacity < 1 || targetCapacity > 100) {
      throw new Error("capacity.targetCapacity must be between 1 and 100");
    }

    const clusterResourceArgs: aws.ecs.ClusterArgs = {
      settings:
        containerInsightsValue === "disabled"
          ? [{ name: "containerInsights", value: "disabled" }]
          : [{ name: "containerInsights", value: containerInsightsValue }],
      tags: { "sst-ec2:component": "ClusterEc2" },
    };

    const [clusterName, clusterFinal, clusterOpts] = applyTransform(
      args.transform?.cluster,
      `${name}Cluster`,
      clusterResourceArgs,
      { parent: this },
    );
    const cluster = new aws.ecs.Cluster(clusterName, clusterFinal, clusterOpts);

    const { role: instanceRole, instanceProfile } = createInstanceRole(
      name,
      { transform: args.transform?.instanceRole },
      this,
    );

    const launchTemplate = createLaunchTemplate(
      name,
      {
        clusterName: cluster.name,
        architecture,
        variant,
        amiVersion,
        instanceType,
        instanceProfileArn: instanceProfile.arn,
        securityGroupIds: args.vpc.securityGroups,
        rootVolumeSize,
        enableAdminContainer,
        userDataMutator: args.transform?.userDataToml,
        transform: args.transform?.launchTemplate,
      },
      this,
    );

    const asg = createAsg(
      name,
      {
        launchTemplateId: launchTemplate.id,
        launchTemplateVersion: pulumi.output(launchTemplate.latestVersion).apply((v) => String(v)),
        vpc: args.vpc,
        minSize,
        maxSize,
        desiredCapacity: desired,
        instanceWarmup: warmup,
        spot,
        transform: args.transform?.autoScalingGroup,
      },
      this,
    );

    const capacityProvider = createCapacityProvider(
      name,
      {
        asgArn: asg.arn,
        targetCapacity,
        instanceWarmupPeriod: warmup,
        managedTerminationProtection: true,
        transform: args.transform?.capacityProvider,
      },
      this,
    );

    const clusterCapacityProviders = attachCapacityProviderToCluster(
      name,
      {
        clusterName: cluster.name,
        capacityProviderName: capacityProvider.name,
        transform: args.transform?.clusterCapacityProviders,
      },
      this,
    );

    const trunking = enableTrunking ? enableAwsvpcTrunking(name, this) : undefined;

    const repoArgs: aws.ecr.RepositoryArgs = {
      name: defaultRepositoryName(cluster.name),
      imageTagMutability: "MUTABLE",
      forceDelete: true,
      imageScanningConfiguration: { scanOnPush: true },
      tags: { "sst-ec2:cluster": name },
    };
    const [repoName, repoFinal, repoOpts] = applyTransform(
      args.transform?.repository,
      `${name}Repository`,
      repoArgs,
      { parent: this },
    );
    const repository = new aws.ecr.Repository(repoName, repoFinal, repoOpts);
    const authToken = aws.ecr.getAuthorizationTokenOutput(
      { registryId: repository.registryId },
      { parent: this },
    );

    this.id = cluster.id;
    this.arn = cluster.arn;
    this.name = cluster.name;
    this.capacityProviderName = capacityProvider.name;
    this.vpc = args.vpc;
    this.architecture = architecture;
    this.imageRepository = { repository, authToken };
    this.nodes = {
      cluster,
      launchTemplate,
      autoScalingGroup: asg,
      capacityProvider,
      clusterCapacityProviders,
      instanceRole,
      instanceProfile,
      trunking,
      repository,
    };

    this.registerOutputs({
      id: this.id,
      arn: this.arn,
      name: this.name,
      capacityProviderName: this.capacityProviderName,
    });
  }

  static get(name: string, args: ClusterEc2GetArgs, opts?: pulumi.ComponentResourceOptions): ClusterHandles {
    const cluster = aws.ecs.Cluster.get(`${name}Cluster`, args.clusterName, {}, opts);
    const handles: ClusterHandles = {
      id: cluster.id,
      arn: cluster.arn,
      name: cluster.name,
      capacityProviderName: pulumi.output(args.capacityProviderName),
      vpc: args.vpc,
      nodes: { cluster, clusterCapacityProviders: undefined },
    };
    if (args.architecture) handles.architecture = args.architecture;
    return handles;
  }
}

function normalizeContainerInsights(
  value: boolean | "enhanced" | undefined,
): "enabled" | "enhanced" | "disabled" {
  if (value === undefined) return "enabled";
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  return "enhanced";
}

function normalizeSpot(
  spot: ClusterEc2Spot | undefined,
  fallbackInstanceType: string,
): SpotConfig | undefined {
  if (!spot) return undefined;
  return {
    onDemandBase: spot.onDemandBase ?? 0,
    onDemandPercentageAboveBase: spot.onDemandPercentageAboveBase ?? 0,
    instanceTypes:
      spot.instanceTypes && spot.instanceTypes.length > 0
        ? spot.instanceTypes
        : [fallbackInstanceType],
  };
}

function defaultRepositoryName(clusterName: pulumi.Input<string>): pulumi.Output<string> {
  return pulumi.output(clusterName).apply((name) => `${name.toLowerCase()}-images`);
}

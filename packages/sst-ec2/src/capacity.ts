import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type { Architecture, BottlerocketVariant, Transform, VpcShape } from "./types.js";
import {
  buildBottlerocketSettings,
  encodeUserData,
  lookupBottlerocketAmi,
  serializeBottlerocketToml,
  type BottlerocketSettings,
} from "./bottlerocket.js";
import { applyTransform } from "./transform.js";
import { defaultInstanceType } from "./normalize.js";

export interface CreateLaunchTemplateArgs {
  clusterName: pulumi.Input<string>;
  architecture: Architecture;
  variant: BottlerocketVariant;
  amiVersion: string;
  instanceType: string;
  instanceProfileArn: pulumi.Input<string>;
  securityGroupIds: pulumi.Input<pulumi.Input<string>[]>;
  rootVolumeSize: number;
  enableAdminContainer: boolean;
  userDataMutator?: (settings: BottlerocketSettings) => BottlerocketSettings;
  transform?: Transform<aws.ec2.LaunchTemplateArgs>;
}

export function createLaunchTemplate(
  name: string,
  args: CreateLaunchTemplateArgs,
  parent: pulumi.ComponentResource,
): aws.ec2.LaunchTemplate {
  const amiId = lookupBottlerocketAmi(args.variant, args.architecture, args.amiVersion);

  const userData = pulumi.output(args.clusterName).apply((clusterName) => {
    const base = buildBottlerocketSettings({
      clusterName,
      enableAdminContainer: args.enableAdminContainer,
    });
    const final = args.userDataMutator ? args.userDataMutator(base) : base;
    return encodeUserData(serializeBottlerocketToml(final));
  });

  const ltArgs: aws.ec2.LaunchTemplateArgs = {
    imageId: amiId,
    instanceType: args.instanceType,
    iamInstanceProfile: { arn: args.instanceProfileArn },
    vpcSecurityGroupIds: args.securityGroupIds,
    userData,
    metadataOptions: {
      httpTokens: "required",
      httpPutResponseHopLimit: 2,
      httpEndpoint: "enabled",
    },
    blockDeviceMappings: [
      {
        deviceName: "/dev/xvda",
        ebs: {
          volumeSize: 2,
          volumeType: "gp3",
          deleteOnTermination: "true",
          encrypted: "true",
        },
      },
      {
        deviceName: "/dev/xvdb",
        ebs: {
          volumeSize: args.rootVolumeSize,
          volumeType: "gp3",
          deleteOnTermination: "true",
          encrypted: "true",
        },
      },
    ],
    tagSpecifications: [
      {
        resourceType: "instance",
        tags: {
          Name: `${name}-ecs-instance`,
          "sst-ec2:cluster": name,
        },
      },
    ],
    updateDefaultVersion: true,
  };

  const [ltName, ltFinal, ltOpts] = applyTransform(args.transform, `${name}LaunchTemplate`, ltArgs, {
    parent,
  });
  return new aws.ec2.LaunchTemplate(ltName, ltFinal, ltOpts);
}

export interface SpotConfig {
  onDemandBase: number;
  onDemandPercentageAboveBase: number;
  instanceTypes: string[];
}

export interface CreateAsgArgs {
  launchTemplateId: pulumi.Input<string>;
  vpc: VpcShape;
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  instanceWarmup: number;
  spot?: SpotConfig;
  transform?: Transform<aws.autoscaling.GroupArgs>;
}

export function createAsg(
  name: string,
  args: CreateAsgArgs,
  parent: pulumi.ComponentResource,
): aws.autoscaling.Group {
  const asgArgs: aws.autoscaling.GroupArgs = {
    vpcZoneIdentifiers: args.vpc.containerSubnets,
    minSize: args.minSize,
    maxSize: args.maxSize,
    desiredCapacity: args.desiredCapacity,
    protectFromScaleIn: true,
    capacityRebalance: true,
    healthCheckGracePeriod: 120,
    healthCheckType: "EC2",
    ...(args.spot
      ? {
          mixedInstancesPolicy: {
            launchTemplate: {
              launchTemplateSpecification: {
                launchTemplateId: args.launchTemplateId,
                version: "$Latest",
              },
              overrides: args.spot.instanceTypes.map((t) => ({ instanceType: t })),
            },
            instancesDistribution: {
              onDemandBaseCapacity: args.spot.onDemandBase,
              onDemandPercentageAboveBaseCapacity: args.spot.onDemandPercentageAboveBase,
              spotAllocationStrategy: "price-capacity-optimized",
            },
          },
        }
      : {
          launchTemplate: {
            id: args.launchTemplateId,
            version: "$Latest",
          },
        }),
    tags: [
      { key: "AmazonECSManaged", value: "true", propagateAtLaunch: true },
      { key: "Name", value: `${name}-ecs-instance`, propagateAtLaunch: true },
    ],
    instanceRefresh: {
      strategy: "Rolling",
      preferences: {
        minHealthyPercentage: 90,
        instanceWarmup: String(args.instanceWarmup),
      },
      triggers: ["tag"],
    },
  };

  const [asgName, asgFinal, asgOpts] = applyTransform(args.transform, `${name}Asg`, asgArgs, {
    parent,
  });
  return new aws.autoscaling.Group(asgName, asgFinal, asgOpts);
}

export interface CreateCapacityProviderArgs {
  asgArn: pulumi.Input<string>;
  targetCapacity: number;
  instanceWarmupPeriod: number;
  managedTerminationProtection: boolean;
  transform?: Transform<aws.ecs.CapacityProviderArgs>;
}

export function createCapacityProvider(
  name: string,
  args: CreateCapacityProviderArgs,
  parent: pulumi.ComponentResource,
): aws.ecs.CapacityProvider {
  const cpArgs: aws.ecs.CapacityProviderArgs = {
    autoScalingGroupProvider: {
      autoScalingGroupArn: args.asgArn,
      managedTerminationProtection: args.managedTerminationProtection ? "ENABLED" : "DISABLED",
      managedScaling: {
        status: "ENABLED",
        targetCapacity: args.targetCapacity,
        minimumScalingStepSize: 1,
        maximumScalingStepSize: 10,
        instanceWarmupPeriod: args.instanceWarmupPeriod,
      },
    },
  };

  const [cpName, cpFinal, cpOpts] = applyTransform(
    args.transform,
    `${name}CapacityProvider`,
    cpArgs,
    { parent },
  );
  return new aws.ecs.CapacityProvider(cpName, cpFinal, cpOpts);
}

export interface AttachCapacityProviderArgs {
  clusterName: pulumi.Input<string>;
  capacityProviderName: pulumi.Input<string>;
  transform?: Transform<aws.ecs.ClusterCapacityProvidersArgs>;
}

export function attachCapacityProviderToCluster(
  name: string,
  args: AttachCapacityProviderArgs,
  parent: pulumi.ComponentResource,
): aws.ecs.ClusterCapacityProviders {
  const ccpArgs: aws.ecs.ClusterCapacityProvidersArgs = {
    clusterName: args.clusterName,
    capacityProviders: [args.capacityProviderName],
    defaultCapacityProviderStrategies: [
      { capacityProvider: args.capacityProviderName, weight: 100, base: 0 },
    ],
  };

  const [attachName, attachFinal, attachOpts] = applyTransform(
    args.transform,
    `${name}ClusterCapacityProviders`,
    ccpArgs,
    { parent },
  );
  return new aws.ecs.ClusterCapacityProviders(attachName, attachFinal, attachOpts);
}

export function enableAwsvpcTrunking(
  name: string,
  parent: pulumi.ComponentResource,
): aws.ecs.AccountSettingDefault {
  return new aws.ecs.AccountSettingDefault(
    `${name}AwsvpcTrunking`,
    { name: "awsvpcTrunking", value: "enabled" },
    { parent },
  );
}

export { defaultInstanceType };

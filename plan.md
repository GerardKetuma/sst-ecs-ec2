# SST on ECS/EC2 with Bottlerocket — Implementation Plan

## 1. Goal

Build sibling SST components — `ClusterEc2`, `ServiceEc2`, `TaskEc2` — that provision Amazon ECS services and tasks on **EC2 container instances running Bottlerocket**, matching as much of the `sst.aws.Service` / `sst.aws.Task` / `sst.aws.Cluster` developer experience as possible while honestly exposing the EC2-specific surface (capacity providers, ASG, placement, instance lifecycle) that Fargate hides.

The deliverable is a pnpm workspace package consumable from any SST project, with the eventual option of upstreaming into `sst/sst`.

## 2. Decisions (from interview)

All defaults below are the components' out-of-box behavior. Every default is overridable via top-level args or Pulumi-level `transform` escape hatches.

### Architecture
- **Packaging:** sibling `ClusterEc2` + `ServiceEc2` + `TaskEc2` components, not a fork of existing SST files.
- **Network mode:** `awsvpc` default (keeps ALB `targetType: "ip"` code path and per-task ENI semantics).
- **Scope:** `ServiceEc2`, `TaskEc2`, `ClusterEc2`, plus `sst dev` live-mode support.
- **Bottlerocket variant:** `aws-ecs-2` default, `aws-ecs-1` opt-in.

### Capacity & ASG
- **`targetCapacity`:** `80%` (AWS-recommended balance of headroom vs packing).
- **Scale floor:** `minSize: 1` (no scale-to-zero by default).
- **Purchasing model:** mixed instances policy — on-demand base + spot overflow.
- **`instanceWarmupPeriod`:** `90s` (leverages Bottlerocket's fast boot).
- **`managedTerminationProtection`:** `ENABLED`; ASG's `protectFromScaleIn` set to match.
- **Placement strategies:** `spread(attribute:ecs.availability-zone)` → `binpack(memory)`.
- **Multi-service sharing:** multiple Services share one Cluster (one ASG, one CP).
- **ENI trunking:** auto-enable account-level `awsvpcTrunking` at deploy time.

### Task sizing & storage
- **CPU/memory inputs:** free-form MiB integers — `cpu: 512`, `memory: 1024`. Breaks input parity with `sst.aws.Service` deliberately (launch types differ).
- **Task-level CPU/mem:** optional; default to undefined so containers share instance capacity.
- **Storage:** `storage` input dropped on the service/task; `rootVolumeSize` added on `ClusterEc2` (EBS root volume applied to all container instances, defaults to `30 GB`).

### Instance / AMI
- **Default instance type:** `t3.medium` (x86_64) / `t4g.medium` (arm64).
- **AMI resolution:** SSM param `/aws/service/bottlerocket/{variant}/{arch}/latest/image_id`, pinned to `latest` by default; `amiVersion?: string` exposed for pinning.
- **Instance IAM managed policies:** `AmazonEC2ContainerServiceforEC2Role` + `AmazonSSMManagedInstanceCore`.

### Ops / debugging
- **Admin container:** disabled by default; `debug.enableAdminContainer: true` opt-in.
- **Control container:** enabled (Bottlerocket default; powers SSM Session Manager).
- **IMDSv2:** required, hop limit 2 (so awsvpc tasks can still reach IMDS).

### Service-level behavior
- **Task SG:** reuse VPC's shared security group (mirrors `sst.aws.Service`).
- **Subnets:** container instances AND task ENIs in `vpc.containerSubnets` (private).
- **Deployment circuit breaker:** enabled + rollback on.
- **`enableExecuteCommand`:** true (parity with `sst.aws.Service`).
- **Container Insights:** enabled on the cluster.

### Rollouts
- **LT change strategy:** ASG `instance_refresh` with `min_healthy_percentage: 90` triggered automatically when `LaunchTemplate` version changes. Managed termination protection ensures graceful drain.

### Out of scope for MVP
- GPU variants (`aws-ecs-*-nvidia`). Captured as post-MVP work.
- Per-task EBS attachments (ECS EBS volume feature). Use EFS volumes (already supported via `FargateBaseArgs.volumes`) for shared persistent state.
- `bridge` / `host` networking. Architecturally allowed via `networkMode?: 'awsvpc' | 'bridge' | 'host'` input but only `awsvpc` gets first-class test coverage in v1.
- Dedicated per-service capacity providers (`dedicatedCapacity: true`).

## 3. Package layout

```
ecs-ec2-sst/                          # pnpm workspace root
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── plan.md                           # this file
├── packages/
│   └── sst-ec2/                      # the publishable package
│       ├── package.json              # name: @gketuma/sst-ec2
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts              # public exports
│       │   ├── cluster-ec2.ts        # ClusterEc2 component
│       │   ├── service-ec2.ts        # ServiceEc2 component
│       │   ├── task-ec2.ts           # TaskEc2 component
│       │   ├── capacity.ts           # ASG + LT + CapacityProvider helpers
│       │   ├── bottlerocket.ts       # TOML user-data builder + AMI lookup
│       │   ├── task-definition.ts    # EC2-flavored task-def builder
│       │   ├── containers.ts         # container normalization + image resolution
│       │   ├── image-builder.ts      # docker-build → shared ECR push
│       │   ├── normalize.ts          # arch/network/cpu/memory normalization
│       │   ├── iam.ts                # instance/task/execution role builders
│       │   ├── load-balancer.ts      # ALB/listener/target wiring + ACM
│       │   ├── transform.ts          # applyTransform helper
│       │   └── types.ts              # shared input types
│       └── tests/
│           ├── cluster-ec2.test.ts
│           ├── service-ec2.test.ts
│           ├── task-ec2.test.ts
│           ├── bottlerocket.test.ts
│           └── capacity.test.ts
├── examples/
│   ├── hello-hono/                   # single service, ALB-fronted
│   │   ├── sst.config.ts
│   │   └── app/
│   ├── multi-service/                # API + worker sharing one cluster
│   │   ├── sst.config.ts
│   │   ├── api/
│   │   └── worker/
│   └── batch-task/                   # TaskEc2 one-shot + EventBridge cron
│       ├── sst.config.ts
│       └── job/
└── docs/
    ├── debug-with-bottlerocket.md    # admin container + SSM walkthrough
    ├── migration-from-fargate.md
    └── architecture.md
```

### Why a workspace package (not local `./components/`)

Interview answer explicit: graduate-ready shape. Importable as:

```ts
import { ClusterEc2, ServiceEc2, TaskEc2 } from "@gketuma/sst-ec2";
```

The package depends on the SST `platform` SDK at runtime — but most of the types we need (`Vpc`, `Cluster`, `Link`, `Component`, `FargateBaseArgs`) are internal to the SST monorepo and not currently exported cleanly. Phase 1 will have to either:
- vendor the minimal subset of helpers we reuse (`normalizeArchitecture`, `normalizeContainers`, `createTaskRole`, `createExecutionRole`) into `packages/sst-ec2/src/_vendored/`, OR
- import via the same global `sst` namespace SST injects into user config files.

Decision: **vendor**. It's explicit, survives SST internal refactors, and makes the package self-contained. We'll track upstream for drift and re-sync if `fargate.ts` gains meaningful improvements.

## 4. Architecture

### Component responsibilities

```
┌────────────────────────────────────────────────────────────────┐
│  ClusterEc2                                                    │
│   ├─ aws.ecs.Cluster (Container Insights ENABLED)              │
│   ├─ aws.iam.Role + InstanceProfile (instance role)            │
│   ├─ aws.ec2.LaunchTemplate (Bottlerocket AMI + TOML UD)       │
│   ├─ aws.autoscaling.Group (mixed instances policy)            │
│   ├─ aws.ecs.CapacityProvider (managed scaling + termination)  │
│   ├─ aws.ecs.ClusterCapacityProviders (links CP → cluster)     │
│   ├─ aws.ecr.Repository (shared for all service/task builds)   │
│   └─ (side-effect) aws:PutAccountSetting awsvpcTrunking=on     │
└────────────────────────────────────────────────────────────────┘
             ▲                              ▲
             │ uses                         │ uses
             │                              │
┌────────────────────────────┐  ┌────────────────────────────┐
│  ServiceEc2                │  │  TaskEc2                   │
│   ├─ IAM task role         │  │   ├─ IAM task role         │
│   ├─ IAM execution role    │  │   ├─ IAM execution role    │
│   ├─ CW LogGroup per ctr   │  │   ├─ CW LogGroup per ctr   │
│   ├─ docker-build.Image    │  │   ├─ docker-build.Image    │
│   │  (when image is a      │  │   │  (when image is a      │
│   │   build spec; pushed   │  │   │   build spec; pushed   │
│   │   to cluster's ECR)    │  │   │   to cluster's ECR)    │
│   ├─ ECS TaskDefinition    │  │   ├─ ECS TaskDefinition    │
│   │   (EC2 compat, awsvpc) │  │   │   (EC2 compat, awsvpc) │
│   ├─ ALB + Listener(s)     │  │   └─ (no ECS Service — run │
│   ├─ TargetGroup(s) ip     │  │       on-demand via SDK)   │
│   ├─ ACM cert + DNS alias  │  └────────────────────────────┘
│   ├─ ECS Service           │
│   │   (capacityProvider)   │
│   ├─ App autoscaling       │
│   └─ CloudMap registration │
└────────────────────────────┘
```

Container `image` is dual-form: pass a string URI (`"nginx:1.27"`, pre-built) to use it verbatim, or pass a build spec (`{ context: "./app", dockerfile?, args?, target?, platform? }`) to have the component build via buildx and push to the cluster's shared ECR. The build platform defaults to the cluster's `architecture` (`linux/amd64` for `x86_64`, `linux/arm64` for `arm64`) and can be overridden per container.

### Key runtime flow

**Deploy:**
1. `ClusterEc2` creates cluster, builds Bottlerocket TOML user-data, provisions LT + ASG + CP, attaches CP as default strategy, and provisions the shared ECR repository.
2. ASG boots N instances with `minSize` capacity; Bottlerocket boots in ~20-30s; ecs-agent registers; CP goes `ACTIVE`.
3. `ServiceEc2` resolves each container's image: string URIs pass through unchanged; build specs trigger a `docker-build.Image` resource that builds via buildx with the cluster's architecture as default platform and pushes to the cluster's shared ECR. Task role, execution role, and task def are created next (`requiresCompatibilities: ["EC2"]`, `networkMode: "awsvpc"`).
4. `ServiceEc2` creates ALB, target group (`targetType: "ip"`), listener, ECS service with `capacityProviderStrategies: [{ capacityProvider: cluster.capacityProviderName }]`.
5. App-autoscaling policies attached to service.

**Scale-out:**
- Task autoscaling bumps `desiredCount`.
- If cluster lacks capacity, CAS's `CapacityProviderReservation` metric goes above 80 → ASG target-tracking adds instances → tasks place.

**Scale-in:**
- Service autoscaling drops `desiredCount`.
- Tasks drain.
- CAS sees `CapacityProviderReservation < 80` → ASG removes instances.
- Managed termination protection blocks ASG from killing instances that still have tasks.
- Bottlerocket instance terminates cleanly.

**LT / AMI change:**
- `pulumi up` produces new LT version.
- Component triggers `aws.autoscaling.Group.instanceRefresh` via Pulumi's `triggers` block.
- `min_healthy_percentage: 90` + termination protection = rolling replacement with graceful drain.

## 5. API sketches

### `ClusterEc2Args`

```ts
import type * as aws from "@pulumi/aws";
import type { Input } from "@pulumi/pulumi";

export interface ClusterEc2Args {
  /**
   * Structural VPC descriptor. Accepts anything that matches `VpcShape`
   * (id + security group + subnet inputs) — `sst.aws.Vpc` fits, but so does
   * any plain object. No direct dependency on SST.
   */
  vpc: VpcShape;

  /** Bottlerocket variant. Defaults to "aws-ecs-2". */
  variant?: Input<"aws-ecs-1" | "aws-ecs-2">;

  /** CPU architecture. Defaults to "x86_64". */
  architecture?: Input<"x86_64" | "arm64">;

  /** Pin to a specific Bottlerocket version; defaults to "latest". */
  amiVersion?: Input<string>;

  /** Instance type(s). Single string or list for mixed instances policy.
   *  Defaults to "t3.medium" (x86) or "t4g.medium" (arm64). */
  instanceType?: Input<string | string[]>;

  /** EBS root volume size for each container instance, in GB. Default: 30. */
  rootVolumeSize?: Input<number>;

  /** Capacity sizing. */
  capacity?: Input<{
    /** Min ASG size. Default: 1. */
    min?: Input<number>;
    /** Max ASG size. Default: 10. */
    max?: Input<number>;
    /** Initial desired. Default: min. */
    desired?: Input<number>;
    /** Managed-scaling target percent. Default: 80. */
    targetCapacity?: Input<number>;
    /** Instance warmup seconds. Default: 90. */
    warmup?: Input<number>;
  }>;

  /** Mixed instances policy. Omit for all on-demand. */
  spot?: Input<{
    /** Number of base (non-spot) instances. Default: 0. */
    onDemandBase?: Input<number>;
    /** Percent of ABOVE-base capacity that's on-demand. Default: 0 (all spot). */
    onDemandPercentageAboveBase?: Input<number>;
    /** Additional instance types for spot (broader pool = fewer interruptions). */
    instanceTypes?: Input<string[]>;
  }>;

  /** Enable Container Insights. Default: true. */
  containerInsights?: Input<boolean | "enhanced">;

  /** Auto-enable account-level awsvpcTrunking. Default: true. */
  enableTrunking?: Input<boolean>;

  /** Debug / break-glass. */
  debug?: Input<{
    /** Enable Bottlerocket admin container (privileged). Default: false. */
    enableAdminContainer?: Input<boolean>;
  }>;

  /** Escape hatches. */
  transform?: {
    cluster?: Transform<aws.ecs.ClusterArgs>;
    clusterCapacityProviders?: Transform<aws.ecs.ClusterCapacityProvidersArgs>;
    capacityProvider?: Transform<aws.ecs.CapacityProviderArgs>;
    launchTemplate?: Transform<aws.ec2.LaunchTemplateArgs>;
    autoScalingGroup?: Transform<aws.autoscaling.GroupArgs>;
    instanceRole?: Transform<aws.iam.RoleArgs>;
    /** Hook to mutate the Bottlerocket TOML before base64-encoding. */
    userDataToml?: (toml: BottlerocketSettings) => BottlerocketSettings;
  };
}

export interface ClusterEc2GetArgs {
  clusterName: Input<string>;
  capacityProviderName: Input<string>;
  vpc: VpcShape;
  architecture?: Architecture;
}
```

### `ServiceEc2Args`

```ts
export interface ServiceEc2Args
  extends Omit<sst.aws.ServiceArgs,
    "cluster" | "cpu" | "memory" | "storage" | "capacity"> {

  cluster: ClusterEc2;

  /** Task CPU in CPU units (1024 = 1 vCPU). Optional on EC2. */
  cpu?: Input<number>;

  /** Task memory in MiB. Optional on EC2. */
  memory?: Input<number>;

  /** Network mode. Default: "awsvpc". */
  networkMode?: Input<"awsvpc" | "bridge" | "host">;

  /** Capacity strategy override. Defaults to cluster's default CP, weight 100. */
  capacityProviderStrategy?: Input<{
    capacityProvider: Input<string>;
    base?: Input<number>;
    weight?: Input<number>;
  }[]>;

  /** Task placement. Defaults to [spread(AZ), binpack(memory)]. */
  placement?: Input<{
    strategies?: Input<{ type: "spread" | "binpack" | "random"; field?: string }[]>;
    constraints?: Input<{ type: "distinctInstance" | "memberOf"; expression?: string }[]>;
  }>;

  transform?: sst.aws.ServiceArgs["transform"] & {
    capacityProviderStrategy?: Transform<any>;
  };
}
```

### `TaskEc2Args`

```ts
export interface TaskEc2Args
  extends Omit<sst.aws.TaskArgs,
    "cluster" | "cpu" | "memory" | "storage"> {

  cluster: ClusterEc2;

  cpu?: Input<number>;
  memory?: Input<number>;
  networkMode?: Input<"awsvpc" | "bridge" | "host">;
  placement?: ServiceEc2Args["placement"];
}
```

## 6. Reuse strategy

### Originally planned to vendor from SST — superseded by re-implementation

Plan §10 "Mid-implementation deviation" explains the decision to re-implement rather than vendor these symbols. The table below is kept as a record of what SST ships that inspired each of our re-implementations.

| Symbol | SST source (reference only) | Our re-implementation |
|---|---|---|
| `FargateContainerArgs` | `fargate.ts:133` | `ContainerArgs` in `src/types.ts` |
| `normalizeArchitecture` | `fargate.ts:805` | `normalizeArchitecture` in `src/normalize.ts` |
| `normalizeContainers` | `fargate.ts:849` | `buildContainers` in `src/containers.ts` |
| `createTaskRole` | `fargate.ts:949` | `createTaskRole` in `src/iam.ts` |
| `createExecutionRole` | `fargate.ts:1009` | `createExecutionRole` in `src/iam.ts` |
| HTTPS cert wiring (SST `DnsValidatedCertificate`) | sst internal | `aws.acm.Certificate` + `aws.acm.CertificateValidation` directly in `src/load-balancer.ts` |
| Image build pipeline (SST `imageBuilder`) | sst internal | `buildImage` / `resolveImage` in `src/image-builder.ts`, backed by `@pulumi/docker-build` and the shared ECR repo created on `ClusterEc2` |

### Rewritten in the new package

| Symbol | Why |
|---|---|
| `normalizeCpu` / `normalizeMemory` | Fargate grid → free-form ints |
| `createTaskDefinitionEc2` | `requiresCompatibilities: ["EC2"]`, remove `ephemeralStorage`, per-container port mappings by `networkMode`, accept `placementConstraints` |
| `createServiceEc2` | Drop `launchType: "FARGATE"` branch, drive via `capacityProviderStrategies` |
| `createTargets` | Keep `targetType: "ip"` for `awsvpc` (MVP); branch to `"instance"` when `bridge`/`host` lands in v2 |

### Copied + lightly adapted (because not exported by SST)

The LB/listener/target/SSL/DNS/cloudmap/autoscaling blocks inside `service.ts` aren't exported as standalone helpers. Strategy:

1. **Phase 1A:** copy the needed closures (`createLoadBalancer`, `createListeners`, `createSsl`, `createDnsRecords`, `createCloudmapService`, `createAutoScaling`) into `packages/sst-ec2/src/load-balancer.ts` unchanged.
2. **Phase 1B:** refactor into pure functions and file an upstream SST PR proposing these be exported. If accepted, we switch to importing them.

Rough LOC estimate: ~400-500 lines of copied code. Manageable; reviewable.

## 7. Technical deep-dives

### 7.1 Bottlerocket user-data (TOML)

```toml
[settings.ecs]
cluster = "{{ cluster-name }}"
# awsvpc trunking picked up automatically by ecs-agent when account setting is on
enable-spot-instance-draining = true
metadata-service-rps = 4096
metadata-service-burst = 8192

[settings.host-containers.admin]
enabled = {{ debug.enableAdminContainer }}   # false by default

[settings.host-containers.control]
enabled = true                                # always on; powers SSM Session Manager

[settings.kernel.sysctl]
"net.ipv4.ip_local_port_range" = "1024 65535"
"fs.inotify.max_user_instances" = "8192"
"net.core.somaxconn" = "4096"
```

Passed through `aws.ec2.LaunchTemplate.userData` base64-encoded:

```ts
const userData = cluster.name.apply((name) => {
  const toml = buildBottlerocketToml({ cluster: name, debug: args.debug });
  return Buffer.from(toml, "utf-8").toString("base64");
});
```

### 7.2 AMI lookup

```ts
const amiId = pulumi.all([args.variant, args.architecture, args.amiVersion])
  .apply(([variant = "aws-ecs-2", arch = "x86_64", version = "latest"]) =>
    aws.ssm.getParameterOutput({
      name: `/aws/service/bottlerocket/${variant}/${arch}/${version}/image_id`,
    }).value,
  );
```

Arch token is `arm64` (not `aarch64`) in the SSM path.

### 7.3 Launch template (essentials)

```ts
new aws.ec2.LaunchTemplate(`${name}LaunchTemplate`, {
  imageId: amiId,
  instanceType: defaultInstanceType,      // ignored when mixed-instances is in use on ASG
  iamInstanceProfile: { arn: instanceProfile.arn },
  vpcSecurityGroupIds: [vpc.securityGroups],
  userData,
  metadataOptions: {
    httpTokens: "required",
    httpPutResponseHopLimit: 2,
    httpEndpoint: "enabled",
  },
  blockDeviceMappings: [
    {
      deviceName: "/dev/xvda",             // Bottlerocket OS volume
      ebs: { volumeSize: 2, volumeType: "gp3", deleteOnTermination: "true" },
    },
    {
      deviceName: "/dev/xvdb",             // Bottlerocket /var data volume
      ebs: {
        volumeSize: args.rootVolumeSize ?? 30,
        volumeType: "gp3",
        deleteOnTermination: "true",
      },
    },
  ],
  tagSpecifications: [
    {
      resourceType: "instance",
      tags: { Name: `${name}-ecs-instance`, "sst:cluster": name },
    },
  ],
});
```

Note Bottlerocket uses two EBS volumes: `/dev/xvda` is the OS image (small, immutable), `/dev/xvdb` is `/var` (the writable data volume where containerd state + `/var/log` live). The `rootVolumeSize` input maps to `xvdb`, not `xvda`.

### 7.4 ASG with mixed instances policy

```ts
new aws.autoscaling.Group(`${name}Asg`, {
  vpcZoneIdentifiers: vpc.containerSubnets,
  minSize: capacity.min,
  maxSize: capacity.max,
  desiredCapacity: capacity.desired,
  protectFromScaleIn: true,                // required for managed termination protection
  capacityRebalance: true,                 // graceful spot interruption handling
  healthCheckGracePeriod: 120,
  mixedInstancesPolicy: spot ? {
    launchTemplate: {
      launchTemplateSpecification: { launchTemplateId: lt.id, version: "$Latest" },
      overrides: (spot.instanceTypes ?? [defaultInstanceType]).map(t => ({ instanceType: t })),
    },
    instancesDistribution: {
      onDemandBaseCapacity: spot.onDemandBase ?? 0,
      onDemandPercentageAboveBaseCapacity: spot.onDemandPercentageAboveBase ?? 0,
      spotAllocationStrategy: "price-capacity-optimized",
    },
  } : undefined,
  launchTemplate: spot ? undefined : { id: lt.id, version: "$Latest" },
  tags: [
    { key: "AmazonECSManaged", value: "", propagateAtLaunch: true },
    { key: "Name", value: `${name}-ecs-instance`, propagateAtLaunch: true },
  ],
  instanceRefresh: {
    strategy: "Rolling",
    preferences: { minHealthyPercentage: 90, instanceWarmup: 90 },
    triggers: ["tag"],                     // refresh when we bump a version tag
  },
});
```

### 7.5 Capacity provider

```ts
const cp = new aws.ecs.CapacityProvider(`${name}CapacityProvider`, {
  autoScalingGroupProvider: {
    autoScalingGroupArn: asg.arn,
    managedTerminationProtection: "ENABLED",
    managedScaling: {
      status: "ENABLED",
      targetCapacity: capacity.targetCapacity,
      minimumScalingStepSize: 1,
      maximumScalingStepSize: 10,
      instanceWarmupPeriod: capacity.warmup,
    },
  },
});

new aws.ecs.ClusterCapacityProviders(`${name}ClusterCapacityProviders`, {
  clusterName: cluster.name,
  capacityProviders: [cp.name],
  defaultCapacityProviderStrategies: [
    { capacityProvider: cp.name, weight: 100, base: 0 },
  ],
});
```

### 7.6 Account-level trunking opt-in

```ts
new aws.ecs.AccountSettingDefault(`${name}TrunkingSetting`, {
  name: "awsvpcTrunking",
  value: "enabled",
}, { parent: self });
```

This mutates the caller's ECS account settings on deploy. Global side effect — document loudly in README.

### 7.7 Task definition (EC2, awsvpc)

```ts
new aws.ecs.TaskDefinition(`${name}Task`, {
  family: pulumi.interpolate`${clusterName}-${name}`,
  requiresCompatibilities: ["EC2"],
  networkMode: "awsvpc",
  cpu: args.cpu?.apply(String),            // optional
  memory: args.memory?.apply(String),      // optional
  executionRoleArn: executionRole.arn,
  taskRoleArn: taskRole.arn,
  volumes,
  containerDefinitions: pulumi.jsonStringify(containerDefs),
  runtimePlatform: {
    cpuArchitecture: architecture.apply(a => a.toUpperCase()),
    operatingSystemFamily: "LINUX",
  },
  // no ephemeralStorage block (Fargate-only)
});
```

### 7.8 Service creation (EC2)

```ts
new aws.ecs.Service(`${name}Service`, {
  name,
  cluster: cluster.arn,
  taskDefinition: taskDef.arn,
  desiredCount: scaling.min,
  capacityProviderStrategies: args.capacityProviderStrategy ?? [{
    capacityProvider: cluster.capacityProviderName,
    weight: 100,
    base: 0,
  }],
  networkConfiguration: {                  // awsvpc only; omit when bridge/host
    assignPublicIp: false,
    subnets: vpc.containerSubnets,
    securityGroups: vpc.securityGroups,
  },
  deploymentCircuitBreaker: { enable: true, rollback: true },
  loadBalancers: targetEntries,
  orderedPlacementStrategies: placement.strategies ?? [
    { type: "spread", field: "attribute:ecs.availability-zone" },
    { type: "binpack", field: "memory" },
  ],
  placementConstraints: placement.constraints,
  enableExecuteCommand: true,
  serviceRegistries: cloudmapService,
  waitForSteadyState: wait,
  forceNewDeployment: true,
});
```

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| SST internals we vendor drift from upstream (esp. `normalizeContainers`) | Pin vendored version in a `VENDOR.md`; CI job checks upstream for changes weekly |
| `awsvpcTrunking` is account-wide, surprising to users in shared AWS accounts | `enableTrunking: false` opt-out; loud README callout; only call `PutAccountSetting` when the setting isn't already `enabled` (read first) |
| `pulumi up` triggering `instance_refresh` mid-incident | `instance_refresh.triggers: ["tag"]` plus a version tag we bump deliberately — not on every `pulumi up` |
| `latest` AMI changes under the user on next deploy | Warn in docs; expose `amiVersion` for pinning; add a `sst:bottlerocket-ami-version` tag to the LT so operators can see which AMI the last refresh used |
| ASG never receives traffic because capacity provider was attached before first `ecs.Service` referenced it | Wire `dependsOn: [clusterCapacityProviders]` on every `ServiceEc2.Service` |
| Cluster delete fails with tasks still running | Implement a `preDestroy` hook: set all services to `desiredCount: 0` and wait; only then delete |
| `managedTerminationProtection` requires ASG `protectFromScaleIn: true` — users who transform the ASG break this invariant | Validate in the component: if `protectFromScaleIn` is set to false via transform and managed protection is on, throw a `VisibleError` |
| Bottlerocket admin container pulls from ECR Public — fails in locked-down VPCs | Document; accept as limitation; users with VPC endpoints can mirror to private ECR |
| Mixed instances policy + `launchTemplate` conflict in AWS API | Only set one or the other; validated in code |
| SST `sst dev` bridge-task swap assumes Fargate | Replace container def with bridge-task stub just like `sst.aws.Service` does; same input env vars |

## 9. Upstream / graduation path

Long-term intent: fold this into SST proper. Roadmap:

1. **Local package (this plan):** proves the API, ships real workloads.
2. **Extract PRs:**
   - Export `createLoadBalancer`, `createListeners`, `createTargets`, `createAutoScaling` from `service.ts`.
   - Add a `transform.clusterCapacityProviders` to `Cluster`.
   - Export `normalizeContainers` / `normalizeCpu` / `normalizeMemory` variants.
3. **Full upstream PR:** `sst.aws.ClusterEc2` + `sst.aws.ServiceEc2` + `sst.aws.TaskEc2`, using the exported helpers. Deprecate our package with a one-line shim that re-exports from `sst`.

## 10. Implementation todo list

> Status summary: Phases 0–6 are implemented in-tree (typecheck + **76 unit tests passing**, up from 63 after the image-builder follow-up). Phase 7 (upstream PRs) is external coordination work not performed by this implementation pass. Phase 8 is explicit post-MVP scope.

### Post-review fix pass (applied)

A code review against this plan surfaced three correctness bugs and several quality issues. All fixed in a follow-up pass:

- **B1 fixed** — `TaskEc2.getSSTLink().properties.clusterArn` was returning empty string. Now exposes the real cluster ARN, plus `clusterName`, `subnets`, `securityGroups`, `assignPublicIp` for complete `RunTask` linkage. Regression test in `tests/task-advanced.test.ts`.
- **B2 fixed** — `ServiceEc2.Service` now wires explicit `dependsOn: [clusterCapacityProviders]` when the cluster's `nodes.clusterCapacityProviders` is present (new cluster path); gracefully skips for `ClusterEc2.get()` path.
- **B3 fixed** — `Input<T>` declarations on static-only config fields (`architecture`, `variant`, `amiVersion`, `instanceType`, `rootVolumeSize`, `containerInsights`, `enableTrunking`, `networkMode`) narrowed to `T`. Previously `typeof === "string"` guards silently fell back to defaults when users passed Pulumi Outputs. Breaking change for the `0.1.0` API.
- **B4 fixed** — Added `transform.loadBalancerSecurityGroup`, `transform.logGroup`, `transform.dnsRecord`, `transform.cloudmapService` escape hatches.
- **CloudMap added** — `ServiceEc2.serviceRegistry: { port, containerName? }` now creates an `aws.servicediscovery.Service` and registers it on the ECS service. Throws clearly when `vpc.cloudmapNamespaceId` isn't set.
- **Narrowed IAM** — execution role's SSM/Secrets/KMS statement now scopes `Resource` to the secret ARNs declared on container `secrets` (falls back to `*` only when nothing is declared, preserving runtime-fetch ergonomics).
- **Nits** — `healthCheck.matcher` default tightened from `"200-399"` to `"200"` with full per-field override; `lbScheme` computed via `parsePortString` instead of string suffix sniff; cast in `task-definition.ts` now has a comment explaining why `pulumi.output(...)` loses literal union types.
- **Shared helpers** — `src/containers.ts` holds `buildContainers`, `collectEnvironmentFiles`, `collectSecretArns`, `firstContainerName`, deduplicating 60+ LOC of copy-paste between `service-ec2.ts` and `task-ec2.ts`.
- **Image-build pipeline added (follow-up fix)** — `src/image-builder.ts` wraps `@pulumi/docker-build`. `ClusterEc2` now always provisions a shared `aws.ecr.Repository` (exposed via `cluster.imageRepository` + `nodes.repository`, with `transform.repository` escape hatch). Services and tasks accept dual-form `image`: a passthrough URI (`Input<string>`) or a build spec (`{ context, dockerfile?, args?, target?, platform? }`). Build specs are built with buildx, tagged `<repo>:<serviceName>`, and pushed via ECR auth. Cluster `architecture` drives the default `linux/amd64` vs `linux/arm64` platform; per-container `platform` overrides it. Clusters looked up via `ClusterEc2.get()` lack the repo, so passing a build spec there throws with a clear message.

New tests added (38 of the 76 total):

| File | What it covers |
|---|---|
| `tests/transform.test.ts` | `applyTransform` undefined / object / function forms |
| `tests/iam.test.ts` | instance role managed-policy attachment; task role `existingRoleArn` reuse path; execution role resource scoping to declared secret ARNs + env-file S3 ARNs |
| `tests/cluster-spot.test.ts` | Multi-element `spot.instanceTypes` fans out `overrides`; single-LT path when `spot` absent |
| `tests/load-balancer-advanced.test.ts` | HTTPS cert creation; existing-cert reuse; Route53 alias; DNS omission; matcher default vs override; `transform.loadBalancerSecurityGroup` |
| `tests/service-advanced.test.ts` | `dependsOn` wiring (with + without ccp); CloudMap service + registry; missing-namespace error; scoped secrets in exec role; https URL computation |
| `tests/task-advanced.test.ts` | B1 regression; full `getSSTLink` properties; public-IP flip |
| `tests/image-builder.test.ts` | `isImageBuildSpec` discrimination; `platformForArchitecture`; string passthrough; build-spec → ECR push ref; missing-repo error on `ClusterEc2.get()`; platform override; cluster ECR wiring; ServiceEc2 + TaskEc2 end-to-end build-spec integration |

### Mid-implementation deviation from plan

Plan §6 called for vendoring SST helpers (`createTaskRole`, `createExecutionRole`, `normalizeContainers`, `imageBuilder`, `DnsValidatedCertificate`) into `_vendored/`. On inspection, those helpers have deep dependencies on SST-internal modules (`Component`, `Link`, `Permission`, `VisibleError`, `bootstrap`), which would have forced us to either vendor the whole dependency graph or stub out those boundaries with shims. Re-implementing the handful of functions we actually need (`iam.ts`, `normalize.ts`, `task-definition.ts`, `load-balancer.ts`'s ACM wiring, and `image-builder.ts` on top of `@pulumi/docker-build`) turned out cheaper (~500 LOC including the image builder) and leaves the package truly standalone — no pinned SST commit to drift against. VENDOR.md and the drift-check CI job are therefore not needed.

### Phase 0 — Repo scaffolding

- [x] Init pnpm workspace: `pnpm-workspace.yaml`, root `package.json` with `packages/*` and `examples/*` globs
- [x] Create `packages/sst-ec2/package.json` with `peerDependencies: { "@pulumi/aws": ">=6.0.0", "@pulumi/pulumi": ">=3.0.0" }` (dropped `sst` peer — package is SST-optional)
- [x] Root `tsconfig.base.json` with strict + ESM
- [x] Set up vitest + Pulumi mocks (`@pulumi/pulumi/runtime.setMocks`) in `packages/sst-ec2/tests/setup.ts`
- [ ] Add GitHub Actions CI: lint, typecheck, unit tests, upstream drift check — **deferred** (local dev validated; CI is infrastructure out of scope for the code pass)
- [x] `.gitignore`, `.prettierrc`, basic TS lint via `tsc --noEmit` (no separate ESLint to keep deps minimal)
- [x] Placeholder `README.md` in package root

### Phase 1 — Core types & helpers (re-implemented instead of vendored — see deviation note above)

- [x] `src/types.ts` — `VpcShape`, `ContainerArgs`, `HealthCheck`, `LinkReceiver`/`LinkInclude`, `PermissionStatement`, `ClusterHandles`, `Transform<T>`, `Input<T>` alias
- [x] `src/transform.ts` — `applyTransform<T>` helper with both partial-arg and function-arg forms
- [x] `src/normalize.ts` — `normalizeArchitecture`, `normalizeNetworkMode`, `normalizeVariant`, `normalizeCpu`, `normalizeMemory`, `defaultInstanceType`, `archToEcsToken`
- [x] `src/iam.ts` — `createInstanceRole` (EC2-for-ECS + SSMManagedInstanceCore), `createTaskRole` (ECS-tasks assume role + ssmmessages), `createExecutionRole` (TaskExecutionRolePolicy + ssm/secrets/kms)
- [x] `src/bottlerocket.ts` — `buildBottlerocketSettings`, `serializeBottlerocketToml`, `encodeUserData`, `lookupBottlerocketAmi`
- [x] `tests/normalize.test.ts`, `tests/bottlerocket.test.ts` — 16 tests covering defaults, round-trip TOML, SSM path shape

### Phase 2 — `ClusterEc2` (core capacity plumbing)

- [x] `src/capacity.ts`:
  - [x] `createLaunchTemplate` — Bottlerocket AMI, TOML user-data (base64), IMDSv2 hop-limit 2, dual EBS (xvda/xvdb)
  - [x] `createAsg` — mixed instances policy when `spot` set, single LT otherwise; `protectFromScaleIn: true`, `AmazonECSManaged` tag, `instance_refresh` (90% healthy, triggers=["tag"])
  - [x] `createCapacityProvider` — managed scaling @ 80 targetCapacity, managed termination protection ENABLED
  - [x] `attachCapacityProviderToCluster` — `ClusterCapacityProviders` with weight=100
  - [x] `enableAwsvpcTrunking` — `AccountSettingDefault`
- [x] `src/cluster-ec2.ts`:
  - [x] `class ClusterEc2 extends pulumi.ComponentResource` (standalone — no sst.Component dep) — orchestrates cluster + capacity + IAM
  - [x] `static get(name, args)` — returns a `ClusterHandles` shape for referencing existing clusters
  - [x] Public getters: `id`, `name`, `arn`, `capacityProviderName`, `vpc`, `nodes.{cluster, launchTemplate, autoScalingGroup, capacityProvider, clusterCapacityProviders, instanceRole, instanceProfile, trunking}`
  - [x] Input validation: capacity min/max/desired/targetCapacity ranges enforced
  - [ ] `transform.autoScalingGroup` invariant-check for `protectFromScaleIn` — **deferred** (tradeoff: Pulumi transforms run late; the check would need a runtime apply. Left for v1.1)
- [x] Unit tests in `tests/cluster-ec2.test.ts` (6 tests): resource graph populated; trunking opt-out honored; targetCapacity=80 + warmup=90 + ENABLED termination protection; mixed instances policy config; capacity validation; AmazonECSManaged tag + protectFromScaleIn=true

### Phase 3 — `ServiceEc2` (ALB-fronted service)

- [x] `src/normalize.ts` — `normalizeCpu`/`normalizeMemory` (positive-int validation), `normalizeNetworkMode` (awsvpc default, bridge/host accepted)
  - [ ] `normalizePortMappings` for `bridge` mode (dynamic host port `hostPort: 0`) — **partially done**: task-definition.ts applies the shape inline, but full bridge/instance target-type path is Phase 8
- [x] `src/task-definition.ts`:
  - [x] `createTaskDefinition` — `requiresCompatibilities: ["EC2"]`, no `ephemeralStorage`, networkMode-aware port mappings, per-container log groups, EFS volume rendering, health check, dependsOn, secrets, env files
  - [x] Unit test coverage via `tests/service-ec2.test.ts` (compat, networkMode)
- [x] `src/load-balancer.ts`:
  - [x] `createLoadBalancer` (ALB + SG + target groups + listeners + optional ACM cert + optional Route53 alias)
  - [x] `parsePortString` for `"80/http"`-style specs
  - [x] `targetType: "ip"` (awsvpc)
  - [x] `healthCheck` object with per-field override (matcher, path, interval, timeout, thresholds) — default `matcher: "200"`
  - [x] `transform.loadBalancerSecurityGroup` and `transform.dnsRecord` escape hatches
- [x] CloudMap service-discovery wiring on `ServiceEc2` via `serviceRegistry: { port, containerName? }` + VPC `cloudmapNamespaceId`
- [x] `src/service-ec2.ts`:
  - [x] `class ServiceEc2 extends pulumi.ComponentResource` (standalone; implements duck-typed `getSSTLink()` for SST compatibility)
  - [x] Constructor order: normalize → containers → task role → exec role → task def → LB → CloudMap → service (capacityProviderStrategies + spread/binpack + circuit breaker + executeCommand) → autoscaling
  - [x] Default capacity provider strategy references `cluster.capacityProviderName` with weight=100
  - [x] Default placement: `[spread(attribute:ecs.availability-zone), binpack(memory)]`
  - [x] `enableExecuteCommand: true`, `deploymentCircuitBreaker.enable=true, rollback=true`
  - [x] Explicit `dependsOn: [cluster.nodes.clusterCapacityProviders]` when provided
  - [x] `getSSTLink()` returns serviceName/clusterArn/taskDefinitionArn/url + ECS + iam:PassRole permissions
  - [ ] `sst dev` bridge-task stub swap — **deferred** (documented in migration-from-fargate.md as a known gap)
- [x] Unit tests across 4 files (16 service-focused tests): EC2 compat on task def, awsvpc mode, capacityProviderStrategies not launchType, placement defaults, circuit breaker+exec on, ALB creation, image/containers mutual exclusion, link shape, dependsOn wiring, CloudMap, scoped secrets, https URL

### Phase 4 — `TaskEc2` (on-demand RunTask)

- [x] `src/task-ec2.ts`:
  - [x] `class TaskEc2 extends pulumi.ComponentResource` (standalone; duck-typed `getSSTLink()`)
  - [x] Shares `normalize*` + `createTaskDefinition` with `ServiceEc2`
  - [x] No `ecs.Service`, only task def + optional public SG
  - [x] `public: true` creates open-ingress SG (routes via `applyTransform`)
  - [x] `getSSTLink()` exposes `taskDefinitionArn` + `clusterArn` + `ecs:RunTask`/`ecs:StopTask`/`ecs:DescribeTasks` + `iam:PassRole`
- [x] Unit tests in `tests/task-ec2.test.ts` + `tests/task-advanced.test.ts` (6 tests): EC2 compat, public-SG toggle, link includes RunTask + PassRole, **clusterArn regression (B1)**, full link properties, assignPublicIp toggle

### Phase 5 — Examples

- [x] `examples/hello-hono/`:
  - [x] Minimal Hono app in `app/` with `Dockerfile`, `index.js`, `package.json`
  - [x] `sst.config.ts` creates `Vpc`, `ClusterEc2` (default config), `ServiceEc2` with `loadBalancer.public: true`
  - [ ] `pnpm sst dev` — N/A (bridge-task stub not in MVP; documented)
  - [ ] `pnpm sst deploy` smoke — **manual verification step** (not runnable without real AWS creds; code structure proves out)
- [x] `examples/multi-service/`:
  - [x] One `ClusterEc2` (mixed instances, spot), two `ServiceEc2` (public API + private worker)
  - [x] Worker uses `scaling.cpuUtilization: 60` to demonstrate autoscaling diff
- [x] `examples/batch-task/`:
  - [x] `TaskEc2` for a one-shot job
  - [x] `sst.aws.Cron` + `sst.aws.Function` calling `ecs:RunTask` via the SST `Resource` link primitive
  - [x] Lambda handler (`runner.ts`) pulls cluster+task-def from the linked `TaskEc2`

### Phase 6 — Documentation

- [x] `docs/architecture.md` — resource graph, deploy flow, scale dynamics, Bottlerocket specifics, account-level side effects, explicit "NOT done" section
- [x] `docs/debug-with-bottlerocket.md`:
  - [x] Enable admin container post-deploy via SSM + `apiclient set`
  - [x] SSM Session Manager → control container walkthrough
  - [x] Reading ecs-agent state via `apiclient exec ecs journalctl`
  - [x] Common failure modes: PROVISIONING stuck, ALB health checks, instance-refresh stall, trunking permission errors
  - [x] Rotating Bottlerocket AMI versions
- [x] `docs/migration-from-fargate.md`:
  - [x] Field-by-field diff table between `sst.aws.Service` and `ServiceEc2`
  - [x] When to choose EC2 vs stay on Fargate
  - [x] Step-by-step code diff (before / after)
  - [x] Gotchas: ACM cert scope, task role ARN changes, log group prefix, trunking side effect
- [x] `packages/sst-ec2/README.md` — install, minimal example, awsvpcTrunking side effect, AMI drift warning, links to docs
- [x] Root `README.md` — project overview, pointer to package + examples + docs + plan

### Phase 7 — Upstream PRs (post-MVP, external coordination)

> **N/A in this implementation pass.** Requires GitHub access, CLA, and real-world review coordination with the SST maintainers. Captured here for the graduation roadmap.

- [ ] Open an issue on `sst/sst` describing the EC2-on-ECS use case
- [ ] PR 1: export `createLoadBalancer`, `createListeners`, `createTargets`, `createAutoScaling` from `service.ts`
- [ ] PR 2: add `transform.clusterCapacityProviders` to `Cluster` component
- [ ] PR 3: add `sst.aws.ClusterEc2` / `ServiceEc2` / `TaskEc2` upstream using the exported helpers
- [ ] Deprecate `@gketuma/sst-ec2` with re-export shim once upstream lands

### Phase 8 — v2 follow-ups (captured now, out of MVP scope)

> **Deferred by design.** These stay open as the roadmap.

- [ ] `bridge` / `host` network mode support (rewrite target-type to `"instance"`, port mapping logic, SG ingress on dynamic range)
- [ ] GPU variants (`aws-ecs-2-nvidia`, `resourceRequirements: [{ type: 'GPU' }]`)
- [ ] Per-task EBS volume attachments (ECS EBS feature)
- [ ] Dedicated per-service capacity providers (`dedicatedCapacity: true`)
- [ ] Stage-aware defaults (e.g. scale-to-zero min=0 in non-prod stages)
- [ ] Auto-detect instance type capacity and validate task CPU/mem fits
- [ ] Bottlerocket update operator integration (if useful on ECS)
- [ ] CloudWatch container insights dashboards (Pulumi component for the dashboard widgets)
- [ ] `sst dev` bridge-task stub swap for live local execution
- [ ] CloudMap service-discovery wiring on `ServiceEc2`
- [ ] Path/header-based listener rules (currently one target group per listener)
- [ ] `transform.autoScalingGroup` invariant guard: reject `protectFromScaleIn: false` while managed termination is on
- [ ] GitHub Actions CI: typecheck + test on PR, plus a weekly Bottlerocket-AMI-freshness check

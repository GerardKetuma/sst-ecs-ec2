# Architecture

## What this package provides

Three SST-compatible components for running ECS on EC2 container instances with Bottlerocket:

- `ClusterEc2` — an ECS cluster backed by a Bottlerocket-based Auto Scaling Group and a managed-scaling capacity provider.
- `ServiceEc2` — a long-running, ALB-fronted ECS service with app-autoscaling.
- `TaskEc2` — an on-demand RunTask target (task definition only, no service).

All three extend `pulumi.ComponentResource` directly (no dependency on SST internals) and implement `getSSTLink()` via duck-typing so they compose with SST's `link` primitive when used inside an `sst.config.ts` project.

## Resource graph

```
ClusterEc2 (sst-ec2:aws:ClusterEc2)
├─ aws.ecs.Cluster                          (Container Insights enabled)
├─ aws.iam.Role + InstanceProfile           (EC2-for-ECS + SSMManagedInstanceCore)
├─ aws.ec2.LaunchTemplate                   (Bottlerocket AMI, TOML user-data, IMDSv2, dual EBS)
├─ aws.autoscaling.Group                    (mixed instances policy when spot set,
│                                            protectFromScaleIn=true, AmazonECSManaged tag,
│                                            instance_refresh rolling @ 90% healthy)
├─ aws.ecs.CapacityProvider                 (managed scaling targetCapacity=80,
│                                            managedTerminationProtection=ENABLED)
├─ aws.ecs.ClusterCapacityProviders         (default strategy: weight=100)
└─ aws.ecs.AccountSettingDefault            (awsvpcTrunking=enabled) — optional

ServiceEc2 (sst-ec2:aws:ServiceEc2)
├─ aws.iam.Role (TaskRole)                  (custom permissions + ssmmessages for Exec)
├─ aws.iam.Role (ExecutionRole)             (AmazonECSTaskExecutionRolePolicy + SSM/Secrets)
├─ aws.cloudwatch.LogGroup (per container)  (30d retention default)
├─ aws.ecs.TaskDefinition                   (requiresCompatibilities=[EC2], networkMode=awsvpc)
├─ aws.ec2.SecurityGroup (ALB)              (if loadBalancer set)
├─ aws.lb.LoadBalancer                      (application, public/internal)
├─ aws.lb.TargetGroup                       (targetType=ip)
├─ aws.lb.Listener                          (per port; HTTPS gets ACM cert)
├─ aws.acm.Certificate                      (if HTTPS and domain.name set)
├─ aws.route53.Record                       (if domain.hostedZoneId set)
├─ aws.ecs.Service                          (capacityProviderStrategies, spread+binpack,
│                                            deploymentCircuitBreaker, enableExecuteCommand)
├─ aws.appautoscaling.Target                (if scaling.max > scaling.min)
└─ aws.appautoscaling.Policy[]              (CPU, Memory, optional RequestCountPerTarget)

TaskEc2 (sst-ec2:aws:TaskEc2)
├─ aws.iam.Role (TaskRole)
├─ aws.iam.Role (ExecutionRole)
├─ aws.cloudwatch.LogGroup (per container)
├─ aws.ecs.TaskDefinition
└─ aws.ec2.SecurityGroup                    (if public=true)
```

## Deploy flow

1. `ClusterEc2` builds the cluster, instance role, launch template (with Bottlerocket TOML user-data), ASG, capacity provider, and attaches the provider as the cluster default. If `enableTrunking !== false`, it also writes an `AccountSettingDefault` enabling `awsvpcTrunking` at the caller's account.
2. ASG boots `minSize` Bottlerocket instances. They register with the cluster via ecs-agent in ~20–30s.
3. `ServiceEc2` builds images/logs/task def and creates the ECS Service referencing the cluster's default capacity provider. If a load balancer is configured, ALB + target group (`targetType=ip`) + listeners are wired before the service; the service registers each container port on the correct target group.
4. App autoscaling target + policies are installed when `scaling.max > scaling.min`.

## Scale dynamics

- **Service scale-out:** CPU or memory utilization passes threshold → app-autoscaling raises `desiredCount`. Tasks place on available instances. If there isn't room, the capacity-provider reservation metric climbs past 80 → managed scaling adds instances to the ASG.
- **Service scale-in:** utilization drops → `desiredCount` drops → tasks drain. Once idle capacity appears, reservation falls below 80 → managed scaling removes instances. `managedTerminationProtection=ENABLED` + `protectFromScaleIn=true` on the ASG ensure ECS-managed instances with tasks are never killed prematurely.

## LaunchTemplate rollout

A change to the launch template (AMI bump, user-data tweak, instance-type change) bumps its version. The ASG `instance_refresh` block is configured with `triggers: ["tag"]` and `minHealthyPercentage: 90`. To trigger a rolling replace, bump a tag on the ASG (via `transform.autoScalingGroup`) — ECS managed termination protection then drains tasks gracefully across the refresh.

## Bottlerocket specifics

- AMI resolved via SSM parameter `/aws/service/bottlerocket/{variant}/{arch}/{version}/image_id`. Default variant `aws-ecs-2`, default version `latest`.
- User-data is TOML, not shell. We build it with `@iarna/toml` and base64-encode before passing to `LaunchTemplate.userData`.
- Two EBS volumes: `/dev/xvda` (OS, 2 GB) and `/dev/xvdb` (`/var`, configurable via `rootVolumeSize`, default 30 GB).
- IMDSv2 required with hop limit 2 so awsvpc tasks still reach IMDS via the task ENI.
- Admin container disabled by default; control container enabled (powers SSM Session Manager).

## Account-level side effect

The trunking `AccountSettingDefault` resource mutates ECS account settings cluster-wide. This is the default to maximize awsvpc ENI density on small instance types (t3.medium holds 2 ENIs without trunking, ~10 with). Set `enableTrunking: false` on `ClusterEc2` in shared AWS accounts where you don't have authority to change the setting.

## What this package does NOT do

- Dockerfile builds / image pushes — bring your own image. (SST's `sst.aws.Service` has `docker-build` built in; we deliberately left that out of MVP scope.)
- `bridge` / `host` networking is allowed via input but only `awsvpc` is test-covered.
- GPU variants (`aws-ecs-*-nvidia`) — you can still point `amiVersion` + `variant` at them and override instance types via `transform.launchTemplate`, but there's no first-class ergonomics.
- Per-task EBS attachments (ECS EBS volume feature). Use EFS via `volumes[]` for shared persistence.
- Service Connect / CloudMap — out of MVP scope.

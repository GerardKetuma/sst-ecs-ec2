# Debugging ECS on Bottlerocket

Bottlerocket has no SSH and no package manager. Three access paths, in order of preference:

1. **ECS Exec** — shell into a running task container.
2. **SSM Session Manager → control container** — inspect host settings via `apiclient`.
3. **Admin container** — privileged root-equivalent shell on the host (opt-in, break-glass).

## 1. ECS Exec into a running task

Prerequisites — `ServiceEc2` enables `enableExecuteCommand: true` by default, so this works out of the box. Your container image must have `/bin/sh` (or `/bin/bash`).

```sh
aws ecs execute-command \
  --cluster $(pulumi stack output clusterName) \
  --task <task-arn> \
  --container Api \
  --interactive \
  --command "/bin/sh"
```

No Bottlerocket-specific setup required. Task role already has the `ssmmessages:*` actions the package installs.

## 2. SSM Session Manager into the control container

Every Bottlerocket instance runs a control container that hosts `apiclient`. Start a Session Manager session against the **instance ID** (not the task):

```sh
# Find the instance
aws ec2 describe-instances \
  --filters "Name=tag:sst-ec2:cluster,Values=Cluster" \
  --query 'Reservations[].Instances[].InstanceId' --output text

# Connect
aws ssm start-session --target i-0abc1234
```

Once inside the control container:

```sh
# Read all current Bottlerocket settings
apiclient get

# Look at the ecs-agent state
apiclient exec ecs journalctl -u ecs -n 100

# Reboot the node
apiclient reboot
```

The control container is sandboxed — you can't `ps` against the host, can't look at other containers' filesystems, can't load kernel modules. For that, use the admin container.

## 3. Admin container (break-glass)

To enable post-hoc without a redeploy:

```sh
aws ssm start-session --target i-0abc1234
# inside the control container:
apiclient set host-containers.admin.enabled=true
```

After ~10 seconds the admin container image pulls (requires reachability to ECR Public — mirror to a private registry if your VPC is locked down) and launches. Enter it via:

```sh
# still in the control container:
enter-admin-container
```

You're now root-equivalent on the host. `journalctl`, `strace`, `ctr` (containerd client), `/var/log`, `/var/lib/containerd`, etc., are all accessible.

When done, disable it via `apiclient set host-containers.admin.enabled=false` — the admin container is a real attack surface.

## Enabling admin container at deploy time

Use the `debug.enableAdminContainer` flag on `ClusterEc2`:

```ts
new ClusterEc2("Cluster", {
  vpc,
  debug: { enableAdminContainer: true },
});
```

The flag is baked into the Bottlerocket user-data TOML, so new instances launch with admin already on. Never enable this in production by default.

## Common failure modes

**Instance boots but doesn't register with the cluster.**
Check user-data: SSM into the control container and run `apiclient get settings.ecs`. If `cluster` is missing or wrong, the TOML didn't render correctly — inspect `transform.userDataToml` if you used one.

**Tasks stuck in PROVISIONING.**
No eligible instances. Either capacity provider hasn't added instances yet (check CloudWatch metric `CapacityProviderReservation` — should be >80 when demand exceeds supply), or task CPU/mem doesn't fit any instance, or `networkMode: awsvpc` hit the ENI limit without trunking. Check `enableTrunking: true` (default).

**Task starts but ALB health checks fail.**
Target group path is `/` by default with a 2xx-3xx matcher. Override via `loadBalancer.healthCheckPath`. Also confirm: task is actually listening on the port you specified, and `awsvpc` + `targetType: "ip"` match (they do by default in this package).

**Deploy hangs on `instance_refresh`.**
Managed termination protection is doing its job — ECS is waiting for tasks to drain. Watch the ASG's `InProgress` state in the console. If tasks never drain, something about your service is blocking (stale target group, failing new task health checks, etc.).

**`awsvpcTrunking` account setting deploy fails.**
The caller role needs `ecs:PutAccountSetting` + `ecs:PutAccountSettingDefault`. Either grant it, or set `enableTrunking: false` on `ClusterEc2` and enable the setting manually via a human with permission.

## Rotating Bottlerocket versions

Pin explicitly in production:

```ts
new ClusterEc2("Cluster", { vpc, amiVersion: "1.22.0" });
```

Bump the version and `pulumi up` — the launch template gets a new version, and because the ASG's `instance_refresh` triggers on tag changes, add a version tag via `transform.autoScalingGroup` or bump manually via AWS CLI:

```sh
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name <asg> \
  --preferences MinHealthyPercentage=90,InstanceWarmup=90
```

Leave the default `latest` if you're OK with new AMIs rolling in whenever AWS publishes.

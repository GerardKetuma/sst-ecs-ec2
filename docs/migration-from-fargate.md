# Migrating from `sst.aws.Service` (Fargate) to `ServiceEc2`

## TL;DR

| Concern | `sst.aws.Service` | `ServiceEc2` |
|---|---|---|
| Launch type | FARGATE | EC2 container instances |
| OS | Fargate platform | Bottlerocket (`aws-ecs-2`) |
| `cpu`, `memory` inputs | `"0.25 vCPU" / "0.5 GB"` strings | integers (`cpu: 512` in CPU units, `memory: 1024` in MiB) |
| `storage` input | Fargate ephemeral 20–200 GB | Dropped; use `ClusterEc2.rootVolumeSize` instead |
| Task-level CPU/mem | Required | Optional (container-level works) |
| Capacity provider | `FARGATE` / `FARGATE_SPOT` | Your ASG-backed capacity provider |
| Instance mgmt | None (Fargate handles it) | You own the ASG, launch template, AMI lifecycle |
| Cost | Per-vCPU-second + per-GB-second | Per-instance-second + EBS |
| Cold start | ~30s task start | Task start on warm instance fast; cluster scale-up adds ~45–90s |

## When to choose EC2 over Fargate

- **Cost at scale.** Fargate has ~20% premium over equivalent EC2. For steady workloads, EC2 pays off past ~2 always-on tasks per instance.
- **Density.** EC2 bin-packs many tasks per instance; Fargate charges per task regardless of packing.
- **GPU / specialized hardware.** Fargate has no GPU support.
- **Spot.** Fargate Spot is useful but thinner; EC2 Spot with mixed instances policy is deeper.
- **Kernel / host access.** You can shell into Bottlerocket instances for debugging; Fargate you cannot.
- **Custom AMIs.** Need a specific OS, kernel module, or pre-baked tooling? EC2 only.

## When to stay on Fargate

- Simplest operational footprint — zero instance management.
- Tiny/intermittent workloads — a single Fargate task costs less than the smallest EC2 box.
- Strong tenant isolation — Fargate's per-task VM boundary is stronger than per-task ENI.

## Step-by-step migration

### Before

```ts
import { Cluster, Service } from "sst/aws";

const cluster = new sst.aws.Cluster("Cluster", { vpc });

const api = new sst.aws.Service("Api", {
  cluster,
  cpu: "0.5 vCPU",
  memory: "1 GB",
  storage: "20 GB",
  image: "myorg/api:latest",
  loadBalancer: { ports: [{ listen: "80/http", forward: "3000/http" }] },
  scaling: { min: 2, max: 10, cpuUtilization: 70 },
});
```

### After

```ts
import { ClusterEc2, ServiceEc2 } from "@gketuma/sst-ec2";

const cluster = new ClusterEc2("Cluster", {
  vpc: {
    id: vpc.id,
    securityGroups: vpc.securityGroups,
    containerSubnets: vpc.privateSubnets,
    publicSubnets: vpc.publicSubnets,
    loadBalancerSubnets: vpc.publicSubnets,
  },
  capacity: { min: 2, max: 10 },
  rootVolumeSize: 30,
});

const api = new ServiceEc2("Api", {
  cluster,
  cpu: 512,
  memory: 1024,
  image: "myorg/api:latest",
  loadBalancer: { ports: [{ listen: "80/http", forward: "3000/http" }] },
  scaling: { min: 2, max: 10, cpuUtilization: 70 },
});
```

### Diff highlights

1. **VPC shape.** `sst.aws.Cluster` accepts a `Vpc` directly. `ClusterEc2` takes a structural `VpcShape`. If you were using `sst.aws.Vpc`, extract the pieces as shown above.
2. **CPU/memory.** `"0.5 vCPU"` → `512`. `"1 GB"` → `1024`.
3. **Storage.** Drop `storage` on the service. Set `rootVolumeSize` on the cluster instead — it's the EBS `/var` volume shared across all tasks on each instance.
4. **Spot.** `capacity: "spot"` on Fargate becomes `spot: { onDemandBase, onDemandPercentageAboveBase }` on `ClusterEc2`. It's a cluster-level choice (all services share the capacity pool), not per-service.
5. **Placement.** You get `placement.strategies` (default `spread(AZ)` + `binpack(memory)`) on `ServiceEc2`, which Fargate never exposed.

## What carries over identically

- `image`, `command`, `entrypoint`, `environment`, `environmentFiles`, `secrets`, `health` — same shape.
- `link` primitive — `ServiceEc2` implements `getSSTLink()`; consumers can `link: [api]` same as before.
- `enableExecuteCommand`, `deploymentCircuitBreaker`, ALB health checks, HTTPS with ACM + Route53 — default-on with the same semantics.
- `transform.taskDefinition`, `transform.service`, etc. — same escape hatch pattern.

## What's missing vs `sst.aws.Service`

- **`sst dev` local bridge-task swap.** We didn't implement the SST dev live-execution pattern in the MVP. `sst dev` will still run your `sst.config.ts`, but tasks won't hot-reload locally yet. Workaround: use `wait: false` and redeploy with a registry tag bump.
- **Docker build integration.** SST's Service builds images via `docker-build`. `ServiceEc2` expects a pushed image ref. Use an SST `sst.aws.Image` (if/when available) or your CI pipeline to produce the image, then pass the ref.
- **Container-level `cpu` / `memory` shortcuts** work the same, but the Fargate strings (`"0.25 vCPU"`) aren't accepted — use integers.
- **Multi-path ALB listener rules.** We only support one target group per listener port. For path-based routing, use `transform.listener` to add rules manually, or attach an external `Alb` with `sst.aws.Service`-style rule matching (roadmap).

## Migration rollout strategy

1. **Side-by-side.** Deploy `ServiceEc2` to a new stage first (e.g. `ec2-preview`). Validate with the same traffic shape (shadow traffic or mirror).
2. **DNS cutover.** If you use Route53 in front, swap the alias record from the Fargate ALB to the EC2 ALB. TTL-driven cutover gives you a clean rollback.
3. **Decommission.** Drop the Fargate `Service` / `Cluster` from `sst.config.ts` once traffic is fully on EC2 and you've watched metrics for ≥ a week.

## Gotchas during migration

- **ACM cert scope.** Certs attached to the Fargate ALB aren't transferable; ACM certs are region-scoped ARNs, so you can reference the same cert on the new ALB by passing `loadBalancer.domain.cert: "<arn>"`.
- **Task role ARNs.** If downstream IAM policies whitelist by ARN, the new task role will have a different ARN — update the policies or use `taskRole: "<existing-arn>"` to reuse.
- **Log group names.** `ServiceEc2` uses `/sst-ec2/<cluster>/<service>/<container>`. Different prefix from SST's `/sst/cluster/...`. Update CloudWatch alarms accordingly.
- **`awsvpcTrunking` enablement.** On by default. If your AWS account already has it enabled, no-op. If you don't want the package mutating account settings, set `enableTrunking: false`.

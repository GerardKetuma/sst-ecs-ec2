# @gketuma/sst-ec2

SST components for running Amazon ECS services and tasks on **Bottlerocket** EC2 container instances.

## Install

```sh
pnpm add @gketuma/sst-ec2
```

Peer dependencies: `@pulumi/aws >= 6`, `@pulumi/pulumi >= 3`. Works inside any SST v3 project.

## Minimal example

```ts
// sst.config.ts
import { ClusterEc2, ServiceEc2 } from "@gketuma/sst-ec2";

export default $config({
  app() {
    return { name: "demo", providers: { aws: true } };
  },
  async run() {
    const vpc = new sst.aws.Vpc("Vpc");
    const cluster = new ClusterEc2("Cluster", { vpc });
    new ServiceEc2("Api", {
      cluster,
      image: "nginx:latest",
      cpu: 256,
      memory: 512,
      loadBalancer: { ports: [{ listen: "80/http", forward: "80/http" }] },
    });
  },
});
```

## Account-wide side effect

On first deploy the component calls `ecs:PutAccountSetting --name awsvpcTrunking --value enabled` on the caller role. This lifts per-instance ENI limits and is required for high-density `awsvpc` task placement. Disable via `enableTrunking: false` on `ClusterEc2`.

## AMI drift

`Bottlerocket` AMIs resolve to `latest` via SSM by default. A new `pulumi up` after AWS publishes a new AMI will bump the LaunchTemplate version and trigger an ASG `instance_refresh`. Pin with `amiVersion: "1.22.0"` for reproducible deploys.

## Docs

- [Architecture](../../docs/architecture.md)
- [Debug with Bottlerocket](../../docs/debug-with-bottlerocket.md)
- [Migration from Fargate](../../docs/migration-from-fargate.md)

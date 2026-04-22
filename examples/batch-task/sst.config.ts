/// <reference path="./.sst/platform/config.d.ts" />

import { ClusterEc2, TaskEc2 } from "@gketuma/sst-ec2";

export default $config({
  app() {
    return {
      name: "batch-task-demo",
      providers: { aws: true },
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc("Vpc", { nat: "ec2" });

    const cluster = new ClusterEc2("Cluster", {
      vpc: {
        id: vpc.id,
        securityGroups: vpc.securityGroups,
        containerSubnets: vpc.privateSubnets,
        publicSubnets: vpc.publicSubnets,
        loadBalancerSubnets: vpc.publicSubnets,
      },
    });

    const job = new TaskEc2("NightlyJob", {
      cluster,
      image: "alpine:latest",
      command: ["sh", "-c", "echo running nightly batch && sleep 5 && echo done"],
      cpu: 256,
      memory: 512,
    });

    const runner = new sst.aws.Function("Runner", {
      link: [job],
      handler: "runner.handler",
      permissions: [
        {
          actions: ["ecs:RunTask", "iam:PassRole"],
          resources: ["*"],
        },
      ],
    });

    new sst.aws.Cron("NightlyCron", {
      schedule: "cron(0 3 * * ? *)",
      function: runner.arn,
    });

    return { runnerArn: runner.arn };
  },
});

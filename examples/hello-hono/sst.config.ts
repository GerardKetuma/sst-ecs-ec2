/// <reference path="./.sst/platform/config.d.ts" />

import { ClusterEc2, ServiceEc2 } from "@gketuma/sst-ec2";

export default $config({
  app(input) {
    return {
      name: "hello-hono",
      removal: input?.stage === "production" ? "retain" : "remove",
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
      capacity: { min: 1, max: 3 },
    });

    const api = new ServiceEc2("Api", {
      cluster,
      image: "nginxdemos/hello:plain-text",
      cpu: 256,
      memory: 256,
      loadBalancer: {
        public: true,
        ports: [{ listen: "80/http", forward: "80/http" }],
      },
    });

    return { url: api.url };
  },
});

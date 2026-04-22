/// <reference path="./.sst/platform/config.d.ts" />

import { ClusterEc2, ServiceEc2 } from "@gketuma/sst-ec2";

export default $config({
  app() {
    return {
      name: "multi-service-demo",
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
      capacity: { min: 2, max: 6 },
      spot: { onDemandBase: 1, onDemandPercentageAboveBase: 0 },
    });

    const api = new ServiceEc2("Api", {
      cluster,
      image: { context: "./api" },
      cpu: 256,
      memory: 512,
      scaling: { min: 1, max: 4 },
      loadBalancer: {
        public: true,
        ports: [{ listen: "80/http", forward: "3000/http" }],
      },
    });

    const worker = new ServiceEc2("Worker", {
      cluster,
      image: { context: "./worker" },
      cpu: 128,
      memory: 256,
      scaling: { min: 1, max: 3, cpuUtilization: 60 },
    });

    return {
      apiUrl: api.url,
      workerName: worker.service.name,
    };
  },
});

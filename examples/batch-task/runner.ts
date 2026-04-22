import { Resource } from "sst";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";

const ecs = new ECSClient({});

export const handler = async (): Promise<{ taskArn: string | undefined }> => {
  const subnets = Resource.NightlyJob.subnets.split(",").filter(Boolean);
  const securityGroups = Resource.NightlyJob.securityGroups.split(",").filter(Boolean);
  const assignPublicIp = Resource.NightlyJob.assignPublicIp === "true" ? "ENABLED" : "DISABLED";

  const result = await ecs.send(
    new RunTaskCommand({
      cluster: Resource.NightlyJob.clusterArn,
      taskDefinition: Resource.NightlyJob.taskDefinitionArn,
      capacityProviderStrategy: [
        {
          capacityProvider: Resource.NightlyJob.capacityProviderName,
          weight: 1,
        },
      ],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups,
          assignPublicIp,
        },
      },
      count: 1,
    }),
  );
  return { taskArn: result.tasks?.[0]?.taskArn };
};

import { Resource } from "sst";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";

const ecs = new ECSClient({});

export const handler = async (): Promise<{ taskArn: string | undefined }> => {
  const result = await ecs.send(
    new RunTaskCommand({
      cluster: Resource.NightlyJob.clusterArn,
      taskDefinition: Resource.NightlyJob.taskDefinitionArn,
      launchType: "EC2",
      count: 1,
    }),
  );
  return { taskArn: result.tasks?.[0]?.taskArn };
};

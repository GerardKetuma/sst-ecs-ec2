import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import type { Input, Transform, VpcShape } from "./types.js";
import { applyTransform } from "./transform.js";

export type ListenerProtocol = "http" | "https";

export interface LoadBalancerPort {
  listen: string;
  forward?: string;
  containerName?: string;
}

export interface LoadBalancerDomain {
  name: Input<string>;
  hostedZoneId?: Input<string>;
  cert?: Input<string>;
}

export interface LoadBalancerHealthCheck {
  path?: Input<string>;
  matcher?: Input<string>;
  interval?: Input<number>;
  timeout?: Input<number>;
  healthyThreshold?: Input<number>;
  unhealthyThreshold?: Input<number>;
}

export interface LoadBalancerArgs {
  public?: boolean;
  ports: LoadBalancerPort[];
  healthCheck?: LoadBalancerHealthCheck;
  domain?: LoadBalancerDomain;
  idleTimeout?: Input<number>;
  transform?: {
    loadBalancer?: Transform<aws.lb.LoadBalancerArgs>;
    loadBalancerSecurityGroup?: Transform<aws.ec2.SecurityGroupArgs>;
    targetGroup?: Transform<aws.lb.TargetGroupArgs>;
    listener?: Transform<aws.lb.ListenerArgs>;
    dnsRecord?: Transform<aws.route53.RecordArgs>;
  };
}

export interface ParsedPort {
  port: number;
  protocol: ListenerProtocol;
}

export interface ResolvedPortMapping {
  listen: ParsedPort;
  forward: ParsedPort;
  containerName?: string;
}

export function parsePortString(value: string): ParsedPort {
  const [portStr, protocolStr] = value.split("/");
  if (!portStr || !protocolStr) {
    throw new Error(`Invalid port spec: "${value}". Expected "<port>/<http|https>"`);
  }
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in "${value}": ${portStr}`);
  }
  if (protocolStr !== "http" && protocolStr !== "https") {
    throw new Error(`Unsupported protocol in "${value}": ${protocolStr}`);
  }
  return { port, protocol: protocolStr };
}

export interface CreateLoadBalancerResult {
  loadBalancer: aws.lb.LoadBalancer;
  securityGroup: aws.ec2.SecurityGroup;
  targetGroups: Map<string, aws.lb.TargetGroup>;
  listeners: aws.lb.Listener[];
  certificate?: aws.acm.Certificate;
  dnsRecord?: aws.route53.Record;
  targetEntries: ResolvedPortMapping[];
}

export function createLoadBalancer(
  name: string,
  args: LoadBalancerArgs,
  vpc: VpcShape,
  parent: pulumi.ComponentResource,
): CreateLoadBalancerResult {
  const isPublic = args.public ?? true;
  const subnets = isPublic ? vpc.publicSubnets : vpc.loadBalancerSubnets;
  if (!subnets) {
    throw new Error(
      isPublic
        ? "vpc.publicSubnets required for a public load balancer"
        : "vpc.loadBalancerSubnets required for an internal load balancer",
    );
  }

  const parsedListenPorts = args.ports.map((p) => parsePortString(p.listen));

  const lbSgArgs: aws.ec2.SecurityGroupArgs = {
    vpcId: vpc.id,
    description: "ALB security group",
    ingress: parsedListenPorts.map((parsed) => ({
      protocol: "tcp",
      fromPort: parsed.port,
      toPort: parsed.port,
      cidrBlocks: ["0.0.0.0/0"],
    })),
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  };
  const [sgName, sgFinal, sgOpts] = applyTransform(
    args.transform?.loadBalancerSecurityGroup,
    `${name}LoadBalancerSecurityGroup`,
    lbSgArgs,
    { parent },
  );
  const sg = new aws.ec2.SecurityGroup(sgName, sgFinal, sgOpts);

  const lbArgs: aws.lb.LoadBalancerArgs = {
    loadBalancerType: "application",
    internal: !isPublic,
    subnets,
    securityGroups: [sg.id],
    ...(args.idleTimeout !== undefined ? { idleTimeout: args.idleTimeout } : {}),
  };
  const [lbName, lbFinal, lbOpts] = applyTransform(
    args.transform?.loadBalancer,
    `${name}LoadBalancer`,
    lbArgs,
    { parent },
  );
  const loadBalancer = new aws.lb.LoadBalancer(lbName, lbFinal, lbOpts);

  const targetGroups = new Map<string, aws.lb.TargetGroup>();
  const targetEntries: ResolvedPortMapping[] = [];
  const listeners: aws.lb.Listener[] = [];

  const resolvedPorts: ResolvedPortMapping[] = args.ports.map((p) => ({
    listen: parsePortString(p.listen),
    forward: parsePortString(p.forward ?? p.listen),
    containerName: p.containerName,
  }));

  const needsCert = resolvedPorts.some((p) => p.listen.protocol === "https");
  let certificateArn: pulumi.Input<string> | undefined;
  let certificate: aws.acm.Certificate | undefined;

  if (needsCert) {
    if (args.domain?.cert) {
      certificateArn = args.domain.cert;
    } else if (args.domain) {
      certificate = new aws.acm.Certificate(
        `${name}Certificate`,
        {
          domainName: args.domain.name,
          validationMethod: "DNS",
        },
        { parent },
      );
      certificateArn = certificate.arn;
    } else {
      throw new Error("HTTPS listener requires a `domain.name` (and optionally `cert`)");
    }
  }

  for (const port of resolvedPorts) {
    const tgKey = `${port.forward.port}-${port.forward.protocol}`;
    let targetGroup = targetGroups.get(tgKey);
    if (!targetGroup) {
      const hc = args.healthCheck;
      const tgArgs: aws.lb.TargetGroupArgs = {
        port: port.forward.port,
        protocol: port.forward.protocol === "https" ? "HTTPS" : "HTTP",
        targetType: "ip",
        vpcId: vpc.id,
        healthCheck: {
          enabled: true,
          path: hc?.path ?? "/",
          healthyThreshold: hc?.healthyThreshold ?? 2,
          unhealthyThreshold: hc?.unhealthyThreshold ?? 3,
          timeout: hc?.timeout ?? 5,
          interval: hc?.interval ?? 30,
          matcher: hc?.matcher ?? "200",
          protocol: port.forward.protocol === "https" ? "HTTPS" : "HTTP",
        },
        deregistrationDelay: 30,
      };
      const [tgName, tgFinal, tgOpts] = applyTransform(
        args.transform?.targetGroup,
        `${name}TargetGroup${port.forward.port}`,
        tgArgs,
        { parent },
      );
      targetGroup = new aws.lb.TargetGroup(tgName, tgFinal, tgOpts);
      targetGroups.set(tgKey, targetGroup);
    }

    targetEntries.push(port);

    const listenerBase: aws.lb.ListenerArgs = {
      loadBalancerArn: loadBalancer.arn,
      port: port.listen.port,
      protocol: port.listen.protocol === "https" ? "HTTPS" : "HTTP",
      defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
    };
    const listenerArgs: aws.lb.ListenerArgs =
      port.listen.protocol === "https" && certificateArn
        ? {
            ...listenerBase,
            certificateArn,
            sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
          }
        : listenerBase;

    const [lnName, lnFinal, lnOpts] = applyTransform(
      args.transform?.listener,
      `${name}Listener${port.listen.port}`,
      listenerArgs,
      { parent },
    );
    listeners.push(new aws.lb.Listener(lnName, lnFinal, lnOpts));
  }

  let dnsRecord: aws.route53.Record | undefined;
  if (args.domain?.hostedZoneId) {
    const recordArgs: aws.route53.RecordArgs = {
      zoneId: args.domain.hostedZoneId,
      name: args.domain.name,
      type: "A",
      aliases: [
        {
          name: loadBalancer.dnsName,
          zoneId: loadBalancer.zoneId,
          evaluateTargetHealth: true,
        },
      ],
    };
    const [rName, rFinal, rOpts] = applyTransform(
      args.transform?.dnsRecord,
      `${name}DnsAlias`,
      recordArgs,
      { parent },
    );
    dnsRecord = new aws.route53.Record(rName, rFinal, rOpts);
  }

  return {
    loadBalancer,
    securityGroup: sg,
    targetGroups,
    listeners,
    certificate,
    dnsRecord,
    targetEntries,
  };
}

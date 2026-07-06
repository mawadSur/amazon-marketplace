// VPC: 2 AZs, public + private-with-egress subnets, one NAT gateway.
// Web ALB is internal (fronted by CloudFront); worker has no ingress.

import { Construct } from "constructs";
import { aws_ec2 as ec2 } from "aws-cdk-lib";

export class Network extends Construct {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1, // single NAT keeps cost down; bump to 2 for AZ-HA egress.
      ipAddresses: ec2.IpAddresses.cidr("10.20.0.0/16"),
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22,
        },
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Interface endpoints so tasks reach Secrets Manager / ECR / logs without
    // routing every AWS API call through the NAT gateway.
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    for (const [name, svc] of [
      ["SecretsManager", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ["EcrApi", ec2.InterfaceVpcEndpointAwsService.ECR],
      ["EcrDocker", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ["CloudWatchLogs", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ] as const) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service: svc,
        privateDnsEnabled: true,
      });
    }
  }
}

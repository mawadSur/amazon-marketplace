// Root stack: composes network → data → compute → edge → cicd and exports the
// values that deploy.yml / the human operator need.

import { Construct } from "constructs";
import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import type { AppConfig } from "./config.js";
import { Network } from "./network.js";
import { Data } from "./data.js";
import { Compute } from "./compute.js";
import { Edge } from "./edge.js";
import { Cicd } from "./cicd.js";

export interface MarketplaceStackProps extends StackProps {
  readonly config: AppConfig;
}

export class MarketplaceStack extends Stack {
  constructor(scope: Construct, id: string, props: MarketplaceStackProps) {
    super(scope, id, {
      ...props,
      // Allows the us-east-1 ACM cert to be referenced from a stack deployed in
      // another region (CloudFront requires the cert in us-east-1).
      crossRegionReferences: true,
    });
    const { config } = props;

    const network = new Network(this, "Network");
    const data = new Data(this, "Data", { vpc: network.vpc, stage: config.stage });
    const compute = new Compute(this, "Compute", {
      vpc: network.vpc,
      data,
      stage: config.stage,
    });

    let cdnDomain: string | undefined;
    if (config.domainName && config.hostedZoneId) {
      const edge = new Edge(this, "Edge", {
        domainName: config.domainName,
        hostedZoneId: config.hostedZoneId,
        alb: compute.alb,
      });
      cdnDomain = edge.distribution.distributionDomainName;
      new CfnOutput(this, "CloudFrontDomain", { value: cdnDomain });
      new CfnOutput(this, "SiteUrl", { value: `https://${config.domainName}` });
    }

    const cicd = new Cicd(this, "Cicd", {
      githubRepo: config.githubRepo,
      githubBranch: config.githubBranch,
      compute,
    });

    // --- Outputs consumed by deploy.yml / the operator -----------------
    new CfnOutput(this, "GitHubDeployRoleArn", { value: cicd.deployRole.roleArn });
    new CfnOutput(this, "EcrWebRepoUri", { value: compute.webRepo.repositoryUri });
    new CfnOutput(this, "EcrWorkerRepoUri", { value: compute.workerRepo.repositoryUri });
    new CfnOutput(this, "EcsClusterName", { value: compute.cluster.clusterName });
    new CfnOutput(this, "EcsWebService", { value: compute.webService.serviceName });
    new CfnOutput(this, "EcsWorkerService", { value: compute.workerService.serviceName });
    new CfnOutput(this, "MigrateTaskDefArn", { value: compute.migrateTask.taskDefinitionArn });
    new CfnOutput(this, "AlbDnsName", { value: compute.alb.loadBalancerDnsName });
    new CfnOutput(this, "AppSecretArn", { value: data.appSecret.secretArn });
    new CfnOutput(this, "DbSecretArn", { value: data.dbSecret.secretArn });
    new CfnOutput(this, "RedisPrimaryEndpoint", {
      value: data.redis.attrPrimaryEndPointAddress,
    });
    new CfnOutput(this, "MediaBucketName", { value: data.mediaBucket.bucketName });
  }
}

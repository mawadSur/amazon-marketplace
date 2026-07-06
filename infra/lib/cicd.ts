// GitHub Actions OIDC deploy role. Assumed by .github/workflows/deploy.yml to
// push images to ECR, run the migrate task, and roll the ECS services — with no
// long-lived AWS access keys.

import { Construct } from "constructs";
import { Stack, aws_iam as iam, aws_ecr as ecr } from "aws-cdk-lib";
import type { Compute } from "./compute.js";

export interface CicdProps {
  readonly githubRepo: string; // "owner/repo"
  readonly githubBranch: string;
  readonly compute: Compute;
}

export class Cicd extends Construct {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: CicdProps) {
    super(scope, id);
    const { githubRepo, githubBranch, compute } = props;
    const stack = Stack.of(this);

    // GitHub's OIDC provider is a single per-account resource. If your account
    // already has one, import it by ARN instead of creating a duplicate by
    // flipping `createOidcProvider` context to false.
    const providerArn = `arn:aws:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = this.node.tryGetContext("createOidcProvider") === false
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "GithubOidc", providerArn)
      : new iam.OpenIdConnectProvider(this, "GithubOidc", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    // Trust only this repo + branch (and workflow_dispatch runs on that ref).
    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: "shezmin-github-deploy",
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": `repo:${githubRepo}:ref:refs/heads/${githubBranch}`,
        },
      }),
      description: "GitHub Actions deploy role (ECR push + ECS deploy)",
      maxSessionDuration: undefined,
    });

    // ECR: auth + push/pull to the two repos only.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"], // GetAuthorizationToken cannot be resource-scoped.
      }),
    );
    for (const repo of [compute.webRepo, compute.workerRepo] as ecr.Repository[]) {
      repo.grantPullPush(this.deployRole);
    }

    // ECS: update the two services + run the migrate task, describe/wait.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:ListTasks",
          "ecs:RunTask",
          "ecs:DescribeTaskDefinition",
        ],
        resources: ["*"], // scope to cluster/service ARNs in a hardening pass.
        conditions: {
          ArnEquals: { "ecs:cluster": compute.cluster.clusterArn },
        },
      }),
    );

    // PassRole so RunTask/UpdateService can hand the task/execution roles to ECS.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          compute.migrateTask.taskRole.roleArn,
          compute.migrateTask.executionRole!.roleArn,
        ],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );
  }
}

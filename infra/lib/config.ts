// Deployment configuration resolved from CDK context / env.
//
// Nothing account-specific is committed. Values come from:
//   • `cdk deploy -c domainName=... -c hostedZoneId=...`  (context), or
//   • the CDK_* env vars for account/region.
// See infra/README.md for the full list.

import type { Construct } from "constructs";

export interface AppConfig {
  /** AWS account id (from CDK_DEFAULT_ACCOUNT or -c account=...). */
  readonly account?: string;
  /** AWS region (from CDK_DEFAULT_REGION or -c region=...). */
  readonly region?: string;
  /** Apex/site domain, e.g. "shezmin.com". Optional: skips edge/DNS if unset. */
  readonly domainName?: string;
  /** Route53 public hosted zone id for domainName. Required if domainName set. */
  readonly hostedZoneId?: string;
  /** GitHub "owner/repo" allowed to assume the OIDC deploy role. */
  readonly githubRepo: string;
  /** git branch(es) permitted to deploy (subject claim); default master. */
  readonly githubBranch: string;
  /** Environment label used in resource tags/names. */
  readonly stage: string;
}

function ctx(scope: Construct, key: string): string | undefined {
  const v = scope.node.tryGetContext(key);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function resolveConfig(scope: Construct): AppConfig {
  const domainName = ctx(scope, "domainName");
  const hostedZoneId = ctx(scope, "hostedZoneId");
  if (domainName && !hostedZoneId) {
    throw new Error(
      "domainName set but hostedZoneId missing — pass -c hostedZoneId=Z... so ACM/Route53 can be wired.",
    );
  }
  return {
    account: ctx(scope, "account") ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: ctx(scope, "region") ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1",
    domainName,
    hostedZoneId,
    githubRepo: ctx(scope, "githubRepo") ?? "your-org/amazon-marketplace",
    githubBranch: ctx(scope, "githubBranch") ?? "master",
    stage: ctx(scope, "stage") ?? "prod",
  };
}

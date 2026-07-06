# Shezmin infra (AWS CDK)

Self-contained CDK app that provisions the production target for the Shezmin
marketplace. **It is its own npm package** (`infra/package.json`,
`infra/tsconfig.json`) and does not affect the Next.js app build.

## What it creates

- **VPC** — 2 AZs, public + private-with-egress + isolated subnets, 1 NAT,
  interface endpoints (Secrets Manager, ECR, CloudWatch Logs) + S3 gateway.
- **ECS Fargate cluster** with:
  - **web** service behind an **internal ALB** (health check `/api/health`),
  - **worker** service (no ingress ports),
  - a one-off **migrate** task definition (`npx prisma migrate deploy`).
- **RDS Postgres** (isolated subnets, encrypted, Multi-AZ in prod).
- **ElastiCache Redis** with **TLS in transit** + at-rest encryption + AUTH.
- **S3 media bucket** — Block Public Access + KMS CMND + enforced TLS + versioning.
- **Secrets Manager** — RDS-managed DB secret, generated Redis AUTH, and an
  aggregated app secret whose keys are injected into task defs.
- **CloudFront + Route53 + ACM** — public HTTPS edge in front of the internal
  ALB via a CloudFront **VPC origin** (only when `domainName`/`hostedZoneId`
  are provided).
- **ECR repos** — `marketplace-web`, `marketplace-worker` (scan-on-push,
  immutable tags, lifecycle pruning).
- **GitHub OIDC deploy role** — least-privilege, trusts one repo+branch;
  consumed by `.github/workflows/deploy.yml`.
- **CloudWatch alarms** — web/worker CPU + memory, ALB target 5xx.

## Prerequisites

- Node 20+, an AWS account, and credentials for a bootstrap/admin session.
- AWS CDK v2 CLI: `npm i -g aws-cdk` (or use the local `aws-cdk` devDep via
  `npx cdk`).

## Install & synth

```bash
cd infra
npm install
npm run typecheck   # tsc --noEmit
npx cdk synth       # render CloudFormation (no AWS calls beyond context lookups)
```

## Context / parameters

Pass with `-c key=value`. Account/region come from the standard `CDK_DEFAULT_*`
env vars if not overridden.

| Key                 | Required | Purpose |
|---------------------|----------|---------|
| `githubRepo`        | yes (for CI) | `owner/repo` allowed to assume the OIDC deploy role. |
| `githubBranch`      | no (`master`) | Branch permitted to deploy. |
| `domainName`        | no       | Apex domain, e.g. `shezmin.com`. Enables the CloudFront/Route53/ACM edge. |
| `hostedZoneId`      | if `domainName` | Route53 public hosted zone id. |
| `stage`             | no (`prod`) | Environment label (tags + HA toggles). |
| `createOidcProvider`| no (`true`) | Set `false` if the account already has the GitHub OIDC provider (imports by ARN instead of creating). |

## Deploy

```bash
# One-time per account/region:
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>

# Deploy everything:
npx cdk deploy \
  -c githubRepo=your-org/amazon-marketplace \
  -c domainName=shezmin.com \
  -c hostedZoneId=Z0123456789ABCDEFGHIJ
```

> **CloudFront cert region:** ACM certs for CloudFront must live in `us-east-1`.
> The stack sets `crossRegionReferences: true`, so you may deploy the main stack
> in another region; CDK provisions the cert in `us-east-1` and wires it across.

## After deploy (operator steps)

1. **Populate the app secret.** The stack creates an empty aggregated secret
   (`AppSecretArn` output). Fill every key the app reads (see the `appKeys` list
   in `lib/compute.ts`): `AUTH_SECRET`, `STRIPE_*`, `RAZORPAY_*`, `TWILIO_*`,
   `KYC_*`, `SHIPROCKET_*`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`,
   `S3_*`, plus `DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`.
   - `DATABASE_URL` = pooled Postgres URL (from the RDS secret / RDS Proxy).
   - `DIRECT_URL` = direct Postgres URL used by `prisma migrate deploy`.
   - `REDIS_URL` = `rediss://:<authToken>@<RedisPrimaryEndpoint>:6379` (TLS).

   ```bash
   aws secretsmanager put-secret-value --secret-id <AppSecretArn> \
     --secret-string '{"AUTH_SECRET":"...","STRIPE_SECRET_KEY":"...", ...}'
   ```

2. **Wire GitHub Actions.** Copy the stack outputs into the repo's
   Actions secrets/vars (see `.github/workflows/deploy.yml` header):
   - secret `AWS_DEPLOY_ROLE_ARN` = `GitHubDeployRoleArn`
   - vars `ECR_REGISTRY`, `ECS_CLUSTER`, `ECS_WEB_SERVICE`, `ECS_WORKER_SERVICE`,
     `ECS_MIGRATE_TASKDEF`, `ECS_MIGRATE_SUBNETS`, `ECS_MIGRATE_SECURITY_GROUPS`,
     `AWS_REGION`, `NEXT_PUBLIC_APP_URL`.

3. **First images.** `deploy.yml` builds/pushes `web` + `worker`, runs the
   migrate task, then rolls both services. The task defs reference the `:latest`
   tag, so the very first deploy needs images present before the services reach
   steady state.

## Notes / non-goals

- The ECS task defs reference `:latest`; `deploy.yml` also pushes an
  immutable `:${{ github.sha }}` tag — pin the task defs to the SHA in a
  hardening pass if you want fully immutable rollouts.
- `ecs:*` and `iam:PassRole` on the deploy role are cluster-scoped via
  conditions; tighten to exact service ARNs when they stabilize.
- Alarms have no SNS action wired — attach a topic/on-call integration.
- Redis AUTH token is generated into Secrets Manager; construct it into
  `REDIS_URL` as shown above.

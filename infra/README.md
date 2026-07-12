# Shezmin infra (AWS CDK)

Self-contained CDK app that provisions the production target for the Shezmin
marketplace. **It is its own npm package** (`infra/package.json`,
`infra/tsconfig.json`) and does not affect the Next.js app build.

## What it creates

- **VPC** — 2 AZs, public + private-with-egress + isolated subnets, 1 NAT,
  interface endpoints (Secrets Manager, ECR, CloudWatch Logs) + S3 gateway.
- **ECS Fargate cluster** with:
  - **web** service behind an **internal ALB**. Container health check =
    `/api/health` (liveness — survives DB/Redis blips); ALB target group health
    check = `/api/health/ready` (readiness — hard-fails on a real DB outage so
    the LB stops routing),
  - **worker** service (no ingress ports),
  - a one-off **migrate** task definition (`npx prisma migrate deploy`) that runs
    in-VPC and reaches Supabase Postgres over the NAT gateway.
- **Postgres** — external, managed by **Supabase** (no RDS). `DATABASE_URL`
  (pooled) + `DIRECT_URL` (direct) live in the app secret and are loaded
  post-deploy; app + migrate tasks reach Supabase over the internet via the NAT
  gateway.
- **ElastiCache Redis** with **TLS in transit** + at-rest encryption + AUTH
  (unchanged).
- **S3 media bucket** — Block Public Access + KMS CMND + enforced TLS + versioning.
- **Secrets Manager** — generated Redis AUTH and an aggregated app secret (which
  also holds the Supabase `DATABASE_URL`/`DIRECT_URL`) whose keys are injected
  into task defs.
- **CloudFront + Route53 + ACM** — public HTTPS edge in front of the internal
  ALB via a CloudFront **VPC origin** (only when `domainName`/`hostedZoneId`
  are provided).
- **ECR repos** — `marketplace-web`, `marketplace-worker` (scan-on-push,
  immutable tags, lifecycle pruning). Deploys are SHA-pinned: `deploy.yml`
  pushes only `:${git-sha}` and registers a fresh task-def revision per deploy
  (never re-pushes `:latest`, which an immutable repo would reject).
- **GitHub OIDC deploy role** — least-privilege, trusts one repo+branch;
  consumed by `.github/workflows/deploy.yml`.
- **CloudWatch alarms** — web/worker CPU + memory, ALB target 5xx — all wired to
  an **SNS topic** (subscribe on-call via `-c alarmEmail=...`).

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
| `alarmEmail`        | no       | Email subscribed to the alarm SNS topic. The address must confirm the subscription email SNS sends. |
| `imageTag`          | no (`latest`) | ECR tag the CDK task defs bootstrap from. Steady-state deploys register SHA-pinned revisions; pass the SHA for a clean first bootstrap (`-c imageTag=<sha>`). |

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
   - `DATABASE_URL` = pooled Supabase Postgres URL (Supabase connection pooler).
   - `DIRECT_URL` = direct Supabase Postgres URL used by `prisma migrate deploy`.
   - `REDIS_URL` = `rediss://:<authToken>@<RedisPrimaryEndpoint>:6379` (TLS).

   ```bash
   aws secretsmanager put-secret-value --secret-id <AppSecretArn> \
     --secret-string '{"AUTH_SECRET":"...","STRIPE_SECRET_KEY":"...", ...}'
   ```

2. **Wire GitHub Actions.** Copy the stack outputs into the repo's
   Actions secrets/vars (see `.github/workflows/deploy.yml` header):
   - secret `AWS_DEPLOY_ROLE_ARN` = `GitHubDeployRoleArn`
   - vars `ECR_REGISTRY`, `ECS_CLUSTER`, `ECS_WEB_SERVICE`, `ECS_WORKER_SERVICE`,
     `ECS_MIGRATE_TASKDEF`, `ECS_MIGRATE_SUBNETS` (= output `MigrateSubnetIds`),
     `ECS_MIGRATE_SECURITY_GROUPS` (= output `MigrateSecurityGroupId`),
     `AWS_REGION`, `NEXT_PUBLIC_APP_URL`.
   - Sentry (optional; enables error reporting + source-map upload):
     secrets `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
     `SENTRY_AUTH_TOKEN`. The server-side `SENTRY_DSN` is read from the app
     secret at runtime; put its value under the `SENTRY_DSN` key in step 1.

3. **First images / SHA-pinning.** `deploy.yml` gates on tests, builds/pushes
   `web` + `worker` as immutable `:${git-sha}` images, runs the migrate task,
   then registers a fresh task-def revision per service pinned to that SHA and
   rolls both services. For the very first deploy the CDK task defs bootstrap
   from `imageTag` (default `latest`); either push an initial `:latest` once or
   `cdk deploy -c imageTag=<sha>` after the first image push.

4. **Confirm the alarm SNS subscription.** If you passed `-c alarmEmail=...`,
   AWS sends a confirmation email to that address — click confirm or the alarms
   have no delivery target.

## Notes / non-goals

- Rollouts are fully SHA-pinned: `deploy.yml` pushes only the immutable
  `:${{ github.sha }}` tag and registers a new task-def revision per service
  pinned to it. The CDK task defs only supply the bootstrap `imageTag`.
- `ecs:*` and `iam:PassRole` on the deploy role are cluster-scoped via
  conditions; tighten to exact service ARNs when they stabilize.
- Alarms publish to an SNS topic (`AlarmTopicArn` output). Subscribe on-call via
  `-c alarmEmail=...` and confirm the subscription, or attach another integration.
- Redis AUTH token is generated into Secrets Manager; construct it into
  `REDIS_URL` as shown above.

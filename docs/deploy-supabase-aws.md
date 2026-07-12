# Production deploy runbook — Shezmin (Supabase + AWS)

Ordered, precise steps to stand up the Shezmin marketplace in production:
Next.js **standalone web** + **BullMQ worker** on **ECS Fargate**, **Supabase
Postgres**, **ElastiCache Redis** (TLS), **S3 + CloudFront** media/edge.

This runbook is the human-operator counterpart to two automated pieces:

- **`infra/`** — the AWS CDK app that provisions everything (see `infra/README.md`).
- **`.github/workflows/deploy.yml`** — the CI pipeline that, once bootstrapped,
  performs steps 5–8 on every push to `master`.

Each step below is tagged **[ONE-TIME]** (per account/region, done once) or
**[EVERY-DEPLOY]** (repeats each release), and notes whether `deploy.yml`
automates it going forward.

> Terminology: "the stack" = the CDK stack in `infra/`. "Stack outputs" = the
> `CfnOutput` values printed at the end of `cdk deploy` (also visible in the
> CloudFormation console). Output names referenced here match
> `infra/lib/marketplace-stack.ts`.

---

## 0. Prerequisites — [ONE-TIME]

- **Node 20+** (`node -v`). The CI gate and both Docker images build on Node 20.
- **AWS CDK v2 CLI**: `npm i -g aws-cdk` (or use the local devDep via `npx cdk`
  from inside `infra/`).
- **Docker** with Buildx (only needed if you build/push images by hand in step 5;
  CI does this for you).
- **Valid AWS credentials** for an admin/bootstrap session in the target account:

  ```bash
  aws sso login --profile <your-profile>
  export AWS_PROFILE=<your-profile>
  aws sts get-caller-identity   # confirm account + identity
  ```

- **A Supabase account** with permission to create a project (step 1).
- Decide your **account id** and **region** now; they thread through every step.

```bash
export ACCOUNT_ID=<aws-account-id>
export AWS_REGION=<region>          # e.g. ap-south-1
export CDK_DEFAULT_ACCOUNT=$ACCOUNT_ID
export CDK_DEFAULT_REGION=$AWS_REGION
```

---

## 1. Create the Supabase project + capture connection URLs — [ONE-TIME]

1. In the Supabase dashboard, create a new project in a region close to
   `$AWS_REGION`. Save the database password.
2. From **Project Settings → Database → Connection string**, copy both URLs:
   - **`DATABASE_URL`** = the **pooled** connection (Supabase connection pooler,
     port `6543`, `?pgbouncer=true`). The app + worker use this at runtime.
   - **`DIRECT_URL`** = the **direct** connection (port `5432`). `prisma migrate
     deploy` uses this (migrations cannot run through the pooler).

Full details, exact URL shapes, SSL params, and how Prisma consumes each:
see **[docs/supabase-connection.md](./supabase-connection.md)**.

Hold both values for step 4 — do not commit them anywhere.

> The stack provisions **no RDS**. App and migrate tasks reach Supabase over the
> internet via the VPC's NAT gateway; nothing further is needed on the AWS side
> for connectivity.

---

## 2. CDK bootstrap — [ONE-TIME] (per account **and** region)

Prepares the account/region for CDK deploys (asset bucket, roles). Run once:

```bash
cd infra
npm install
npx cdk bootstrap aws://$ACCOUNT_ID/$AWS_REGION
```

> If you use a custom domain, the CloudFront ACM cert is provisioned in
> `us-east-1` via cross-region references. If your main region is **not**
> `us-east-1`, also bootstrap there once:
> `npx cdk bootstrap aws://$ACCOUNT_ID/us-east-1`.

---

## 3. CDK deploy — [ONE-TIME] to create infra; re-run only on infra changes

> **Creates billable resources**: NAT gateway, ALB, ECS Fargate services,
> ElastiCache Redis, S3, CloudFront, KMS, Secrets Manager, CloudWatch. You are
> charged from this point on.

From `infra/`, after `npm run typecheck && npx cdk synth` passes:

```bash
npx cdk deploy \
  -c githubRepo=<owner>/amazon-marketplace \
  -c githubBranch=master \
  -c stage=prod \
  -c imageTag=<git-sha> \
  -c alarmEmail=oncall@example.com \
  -c domainName=shezmin.com \
  -c hostedZoneId=Z0123456789ABCDEFGHIJ
```

Context params (`-c key=value`):

| Key | Required | Notes |
|-----|----------|-------|
| `githubRepo` | yes (for CI) | `owner/repo` allowed to assume the OIDC deploy role. |
| `githubBranch` | no (`master`) | Branch permitted to deploy. |
| `stage` | no (`prod`) | Environment label; use `prod`. |
| `imageTag` | no (`latest`) | Tag the task defs bootstrap from. First deploy has no `:latest` yet — either push an initial image first (step 5) or pass `-c imageTag=<git-sha>` here. |
| `alarmEmail` | no | Address subscribed to the alarm SNS topic (must confirm — step 10). |
| `domainName` | no | Apex domain (e.g. `shezmin.com`). Enables the CloudFront/Route53/ACM public edge. |
| `hostedZoneId` | required **if** `domainName` set | Route53 public hosted zone id. |
| `createOidcProvider` | no (`true`) | Set `false` if the account already has the GitHub OIDC provider. |

**Record these stack outputs** (used in later steps and in CI config):

- `AppSecretArn`, `GitHubDeployRoleArn`
- `EcrWebRepoUri`, `EcrWorkerRepoUri`
- `EcsClusterName`, `EcsWebService`, `EcsWorkerService`
- `MigrateTaskDefArn`, `MigrateSubnetIds`, `MigrateSecurityGroupId`
- `RedisPrimaryEndpoint`, `AlbDnsName`, `AlarmTopicArn`
- `CloudFrontDomain` / `SiteUrl` (only when a domain was supplied)

**Wire CI once**: copy these into the repo's GitHub Actions settings so
`deploy.yml` can run (Settings → Secrets and variables → Actions):

- secret `AWS_DEPLOY_ROLE_ARN` = `GitHubDeployRoleArn`
- vars: `AWS_REGION`, `ECR_REGISTRY` (registry host of the ECR URIs),
  `ECS_CLUSTER` = `EcsClusterName`, `ECS_WEB_SERVICE` = `EcsWebService`,
  `ECS_WORKER_SERVICE` = `EcsWorkerService`,
  `ECS_MIGRATE_TASKDEF` = `MigrateTaskDefArn`,
  `ECS_MIGRATE_SUBNETS` = `MigrateSubnetIds`,
  `ECS_MIGRATE_SECURITY_GROUPS` = `MigrateSecurityGroupId`,
  `NEXT_PUBLIC_APP_URL` (public site URL).
- optional Sentry secrets: `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`.

Re-run `cdk deploy` **only** when infra itself changes — never for app code
releases (those are steps 5–7, automated by CI).

---

## 4. Load the app secret — [ONE-TIME] to seed; update when a value rotates

The stack creates an **empty** aggregated secret at `AppSecretArn`. Its keys are
injected into the web/worker/migrate task definitions, so the app cannot start
until it is populated.

1. Start from the template **[docs/secrets-template.json](./secrets-template.json)**
   — it lists every key the app reads (matches `appKeys` in
   `infra/lib/compute.ts`): `AUTH_SECRET`, `STRIPE_*`, `RAZORPAY_*`, `TWILIO_*`,
   `KYC_*`, `SHIPROCKET_*`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`,
   `S3_*`, `SENTRY_DSN`, plus the three that make or break startup:
   - **`DATABASE_URL`** — pooled Supabase URL from step 1 (runtime).
   - **`DIRECT_URL`** — direct Supabase URL from step 1 (migrations).
   - **`REDIS_URL`** — `rediss://:<authToken>@<RedisPrimaryEndpoint>:6379`
     (TLS `rediss://`). The `authToken` is the generated Redis AUTH secret;
     `<RedisPrimaryEndpoint>` is the stack output.
   - **`AUTH_SECRET`** — random 32+ byte secret (`openssl rand -base64 32`).
2. Fill in real values, then push the whole JSON into the secret. Follow
   **[docs/secrets-load.md](./secrets-load.md)** for the exact command and
   validation; the core call is:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id <AppSecretArn> \
     --secret-string file://secrets.filled.json
   ```

Do this **before** the first migrate/deploy. Repeat only to rotate a value
(then force a new deployment — step 7 — so tasks pick it up).

---

## 5. Build + push web and worker images to ECR — [EVERY-DEPLOY] · automated by CI

Two immutable, SHA-pinned images go to the ECR repos from step 3:

- **web** — `Dockerfile.web` (Next.js standalone server) → `marketplace-web`
- **worker** — `Dockerfile` (BullMQ worker) → `marketplace-worker`

`deploy.yml`'s `build-and-push` job does exactly this on every push to `master`:
OIDC login → ECR login → Buildx → `docker/build-push-action` for each image,
tagging **only** `:${{ github.sha }}` (repos are IMMUTABLE — `:latest` is never
re-pushed). The web build inlines `NEXT_PUBLIC_APP_URL` and the Sentry build-args.

**Manual first-image / break-glass** equivalent (`GIT_SHA` = commit you're
shipping; `ECR_REGISTRY` = `<account>.dkr.ecr.<region>.amazonaws.com`):

```bash
export GIT_SHA=$(git rev-parse HEAD)
export ECR_REGISTRY=<EcrWebRepoUri without the /marketplace-web suffix>

aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ECR_REGISTRY

docker buildx build --push -f Dockerfile.web \
  --build-arg NEXT_PUBLIC_APP_URL=https://shezmin.com \
  -t $ECR_REGISTRY/marketplace-web:$GIT_SHA .

docker buildx build --push -f Dockerfile \
  -t $ECR_REGISTRY/marketplace-worker:$GIT_SHA .
```

> If you deployed the stack with `-c imageTag=<git-sha>` in step 3, push these
> images **before** (or matching) that SHA so the initial task defs resolve.

---

## 6. Run the one-off migrate task (`prisma migrate deploy`) — [EVERY-DEPLOY with migrations] · automated by CI

Migrations are a **release step**, intentionally **not** baked into the image.
The migrate task runs in-VPC (reaches Supabase over NAT) using `DIRECT_URL` from
the app secret. `deploy.yml`'s `migrate` job registers a SHA-pinned migrate
revision (worker image), runs it, waits, and asserts exit code 0.

**Manual equivalent** using the stack outputs:

```bash
aws ecs run-task \
  --cluster <EcsClusterName> \
  --task-definition <MigrateTaskDefArn> \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<MigrateSubnetIds>],securityGroups=[<MigrateSecurityGroupId>],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["npx","prisma","migrate","deploy"]}]}'
```

Wait for it and assert success before rolling services:

```bash
TASK_ARN=<taskArn from run-task>
aws ecs wait tasks-stopped --cluster <EcsClusterName> --tasks "$TASK_ARN"
aws ecs describe-tasks --cluster <EcsClusterName> --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode'   # must be 0
```

> `MigrateSubnetIds` / `MigrateSecurityGroupId` are the stack outputs (in CI:
> vars `ECS_MIGRATE_SUBNETS` / `ECS_MIGRATE_SECURITY_GROUPS`). Skip this step for
> releases with no new migrations.

---

## 7. Force a new deployment of web + worker — [EVERY-DEPLOY] · automated by CI

For each service, register a fresh task-def revision pinned to the new
`:${GIT_SHA}` image and point the service at it. `deploy.yml`'s `deploy` job does
this via its `roll()` helper (describe service → swap `containerDefinitions[0].image`
→ `register-task-definition` → `update-service`), then waits for stability.

**Manual equivalent** (repeat per service; or, if the running task def already
references the right image and you only changed the secret, a simple
`update-service --force-new-deployment` suffices):

```bash
# Preferred: re-point to a SHA-pinned revision (mirrors CI). See deploy.yml roll().
aws ecs update-service --cluster <EcsClusterName> \
  --service <EcsWebService>    --task-definition <new-web-td-arn>
aws ecs update-service --cluster <EcsClusterName> \
  --service <EcsWorkerService> --task-definition <new-worker-td-arn>

aws ecs wait services-stable --cluster <EcsClusterName> \
  --services <EcsWebService> <EcsWorkerService>
```

---

## 8. Smoke test the health endpoints — [EVERY-DEPLOY] · CI waits on stability; verify manually

Two endpoints (implemented in `src/app/api/health/route.ts` and
`src/app/api/health/ready/route.ts`):

- **`/api/health`** — liveness. Survives brief DB/Redis blips. Used as the
  container health check.
- **`/api/health/ready`** — readiness. Hard-fails on a real DB outage; used as
  the ALB target-group health check.

Hit them through the public edge (CloudFront `SiteUrl` when a domain is set,
otherwise the internal `AlbDnsName` from inside the VPC / via a bastion):

```bash
curl -fsS https://shezmin.com/api/health        && echo OK-live
curl -fsS https://shezmin.com/api/health/ready   && echo OK-ready
```

Both must return 200. A 200 on `/api/health` but non-200 on `/api/health/ready`
means the app is up but its DB (Supabase) is unreachable — check `DATABASE_URL`
in the secret and Supabase status.

> The ALB is **internal**; public traffic arrives only through CloudFront via a
> VPC origin. There is no public ALB DNS to curl directly.

---

## 9. Register provider webhooks — [ONE-TIME] per provider (update on URL change)

Point each provider at the public site URL (`SiteUrl`). Routes exist at:

| Provider | Webhook URL | Route file | Secret key |
|----------|-------------|------------|------------|
| **Stripe** | `https://shezmin.com/api/webhooks/stripe` | `src/app/api/webhooks/stripe/route.ts` | `STRIPE_WEBHOOK_SECRET` (in app secret) |
| **RazorpayX** | `https://shezmin.com/api/webhooks/razorpay` | `src/app/api/webhooks/razorpay/route.ts` | `RAZORPAY_WEBHOOK_SECRET` |
| **Shiprocket** | `https://shezmin.com/api/webhooks/shiprocket` | `src/app/api/webhooks/shiprocket/route.ts` | `SHIPROCKET_*` |

For each provider: create the webhook in its dashboard, subscribe the relevant
events (payments/payouts/refunds for Stripe & RazorpayX; shipment status for
Shiprocket), copy the generated signing secret into the app secret (step 4), and
re-run step 7 so the running tasks pick up the secret. Send a test event and
confirm a 2xx in CloudWatch logs.

> Not automated by CI — providers are configured out-of-band and only change
> when the public URL or signing secret rotates.

---

## 10. Subscribe the SNS alarm topic — [ONE-TIME]

CloudWatch alarms (web/worker CPU + memory, ALB target 5xx) publish to the SNS
topic `AlarmTopicArn`.

- If you passed `-c alarmEmail=...` in step 3, AWS already sent a **confirmation
  email** to that address — click **Confirm subscription** or alarms have no
  delivery target.
- To add more subscribers (extra email, PagerDuty/Slack via HTTPS, etc.):

  ```bash
  aws sns subscribe --topic-arn <AlarmTopicArn> \
    --protocol email --notification-endpoint oncall2@example.com
  ```

Confirm every subscription. Verify by temporarily breaching an alarm or checking
the SNS console shows `Confirmed` subscriptions.

---

## Quick reference — one-time vs every-deploy

| Step | Cadence | Automated by `deploy.yml`? |
|------|---------|----------------------------|
| 0 Prereqs | one-time | no |
| 1 Supabase project + URLs | one-time | no |
| 2 `cdk bootstrap` | one-time / region | no |
| 3 `cdk deploy` + wire CI | one-time (re-run on infra change) | no |
| 4 Load app secret | one-time (update on rotation) | no |
| 5 Build + push images | every deploy | **yes** (`build-and-push`) |
| 6 Migrate task | every deploy w/ migrations | **yes** (`migrate`) |
| 7 Roll web + worker | every deploy | **yes** (`deploy`) |
| 8 Smoke test health | every deploy | partial (waits for stability) |
| 9 Provider webhooks | one-time / provider | no |
| 10 SNS alarm subscription | one-time | no |

**Going forward**, a normal release is just: merge to `master` → `deploy.yml`
runs the gate (typecheck + test), then steps 5 → 6 → 7 → wait-for-stable
automatically. Steps 0–4, 9, 10 are operator groundwork you do once (or when a
secret/URL/infra detail changes).

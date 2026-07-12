// Compute layer: ECR repos, ECS Fargate cluster, web service (behind an
// internal ALB; container health check = /api/health liveness, ALB target
// group health check = /api/health/ready readiness), worker service (no
// ports), a one-off migrate task definition (with its own DB-reaching SG),
// least-privilege roles, and CloudWatch alarms wired to an SNS topic.

import { Construct } from "constructs";
import {
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_sns as sns,
  aws_sns_subscriptions as snsSubscriptions,
} from "aws-cdk-lib";
import type { Data } from "./data.js";

export interface ComputeProps {
  readonly vpc: ec2.Vpc;
  readonly data: Data;
  readonly stage: string;
}

const WEB_REPO = "marketplace-web";
const WORKER_REPO = "marketplace-worker";

export class Compute extends Construct {
  readonly cluster: ecs.Cluster;
  readonly webRepo: ecr.Repository;
  readonly workerRepo: ecr.Repository;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly webService: ecs.FargateService;
  readonly workerService: ecs.FargateService;
  readonly migrateTask: ecs.FargateTaskDefinition;
  readonly webSecurityGroup: ec2.SecurityGroup;
  /** SG for the one-off migrate task; reaches Supabase Postgres over egress. */
  readonly migrateSecurityGroup: ec2.SecurityGroup;
  /** SNS topic the CloudWatch alarms publish to (subscribe on-call here). */
  readonly alarmTopic: sns.Topic;
  readonly appPort = 3000;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);
    const { vpc, data, stage } = props;

    // Image tag the CDK-synthesized task defs reference. Steady-state deploys
    // register NEW task-def revisions pinned to the git SHA (see deploy.yml);
    // this value is only the bootstrap tag used before the first CI deploy.
    // Because ECR repos are IMMUTABLE we never re-push `:latest`; pass the SHA
    // for a clean bootstrap: `cdk deploy -c imageTag=<sha>`.
    const imageTag = this.node.tryGetContext("imageTag") ?? "latest";

    // --- ECR repos (immutable tags, scan on push, prune untagged) -------
    const repoProps: ecr.RepositoryProps = {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { description: "Expire untagged", tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(14) },
        { description: "Keep last 20 tagged", tagStatus: ecr.TagStatus.ANY, maxImageCount: 20 },
      ],
    };
    this.webRepo = new ecr.Repository(this, "WebRepo", { repositoryName: WEB_REPO, ...repoProps });
    this.workerRepo = new ecr.Repository(this, "WorkerRepo", { repositoryName: WORKER_REPO, ...repoProps });

    // --- Cluster -------------------------------------------------------
    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsights: true,
      clusterName: `shezmin-${stage}`,
    });

    // --- Least-privilege roles ----------------------------------------
    // Execution role: pull images + read log config + read the secrets it
    // injects. Task role: what the *app* can do at runtime (S3, KMS, secrets).
    const executionRole = new iam.Role(this, "ExecRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    data.appSecret.grantRead(executionRole);
    data.redisAuthSecret.grantRead(executionRole);

    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    data.mediaBucket.grantReadWrite(taskRole);
    data.mediaKey.grantEncryptDecrypt(taskRole);
    data.appSecret.grantRead(taskRole);

    // --- Shared secret env mapping -------------------------------------
    const secretEnv = this.buildSecretEnv(data);
    const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";
    const commonEnv = {
      NODE_ENV: "production",
      AWS_REGION: region,
      S3_BUCKET: data.mediaBucket.bucketName,
      // Real AWS region for the S3 client (env default is "auto", an R2 convention
      // the AWS SDK rejects). The bucket lives in the stack's region.
      S3_REGION: region,
      // Sentry environment tag (DSN itself is injected via secretEnv). Non-secret.
      SENTRY_ENVIRONMENT: stage,
    } as const;

    const logGroup = new logs.LogGroup(this, "AppLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Web task + service (behind internal ALB) ----------------------
    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    webTask.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(this.webRepo, imageTag),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup }),
      environment: { ...commonEnv, PORT: String(this.appPort) },
      secrets: secretEnv,
      portMappings: [{ containerPort: this.appPort }],
      // Container health check = LIVENESS (/api/health): 200 whenever the
      // process is up, so a transient DB/Redis blip does NOT kill the task.
      // Readiness (DB hard-fail) is enforced by the ALB target group below.
      healthCheck: {
        command: [
          "CMD-SHELL",
          `node -e "fetch('http://127.0.0.1:${this.appPort}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    const webSg = new ec2.SecurityGroup(this, "WebSg", {
      vpc,
      description: "Web tasks",
      allowAllOutbound: true,
    });
    this.webService = new ecs.FargateService(this, "WebService", {
      cluster: this.cluster,
      taskDefinition: webTask,
      serviceName: "web",
      desiredCount: stage === "prod" ? 2 : 1,
      securityGroups: [webSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: false, // internal; CloudFront is the public edge.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    const listener = this.alb.addListener("Http", {
      port: 80,
      open: false,
    });
    listener.addTargets("WebTargets", {
      port: this.appPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.webService],
      // ALB target group health check = READINESS (/api/health/ready): hard-
      // fails on a real DB outage so the LB stops routing to a task that cannot
      // serve, while the container liveness probe keeps the task alive.
      healthCheck: {
        path: "/api/health/ready",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(15),
    });

    // App tasks may reach Redis; Redis only accepts from app SGs. (Postgres is
    // Supabase — reached over egress via NAT, no SG ingress rule needed.)
    data.redisSecurityGroup.addIngressRule(webSg, ec2.Port.tcp(6379), "web -> redis");

    // --- Worker task + service (no ingress) ----------------------------
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
    });
    workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromEcrRepository(this.workerRepo, imageTag),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup }),
      environment: commonEnv,
      secrets: secretEnv,
    });
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc,
      description: "Worker tasks",
      allowAllOutbound: true,
    });
    this.workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: this.cluster,
      taskDefinition: workerTask,
      serviceName: "worker",
      desiredCount: 1,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
    });
    data.redisSecurityGroup.addIngressRule(workerSg, ec2.Port.tcp(6379), "worker -> redis");

    // --- One-off migrate task (used by deploy.yml release step) ---------
    // Reuses the worker image (ships prisma CLI + schema). deploy.yml registers
    // a SHA-pinned revision and runs it with `npx prisma migrate deploy`.
    this.migrateTask = new ecs.FargateTaskDefinition(this, "MigrateTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });
    this.migrateTask.addContainer("migrate", {
      image: ecs.ContainerImage.fromEcrRepository(this.workerRepo, imageTag),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "migrate", logGroup }),
      environment: commonEnv,
      secrets: secretEnv,
      command: ["npx", "prisma", "migrate", "deploy"],
    });

    // The migrate task runs in-VPC via `aws ecs run-task` (deploy.yml), which
    // needs an explicit SG + subnets. It reaches Supabase Postgres over the
    // internet via the NAT gateway (allowAllOutbound is true), and reaches
    // Secrets Manager via the VPC interface endpoint.
    const migrateSg = new ec2.SecurityGroup(this, "MigrateSg", {
      vpc,
      description: "One-off migrate task",
      allowAllOutbound: true,
    });
    this.migrateSecurityGroup = migrateSg;

    this.webSecurityGroup = webSg;
    this.alarmTopic = this.addAlarms(props.stage);
  }

  /**
   * Map individual keys out of the aggregated app secret + the DB/Redis
   * secrets into container env. The web/worker code reads these via env.ts.
   */
  private buildSecretEnv(data: Data): Record<string, ecs.Secret> {
    const appKeys = [
      "AUTH_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "RAZORPAY_ACCOUNT_NUMBER",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_VERIFY_SERVICE_SID",
      // KYC — Signzy (India PAN/GSTIN). Supersedes the legacy KYC_PROVIDER_* vars,
      // which are intentionally NOT injected: the app uses Signzy when these are set.
      "SIGNZY_BASE_URL",
      "SIGNZY_USERNAME",
      "SIGNZY_PASSWORD",
      "SIGNZY_REALM",
      "SIGNZY_LOGIN_PATH",
      "SIGNZY_PAN_PATH",
      "SIGNZY_GSTIN_PATH",
      "SHIPROCKET_EMAIL",
      "SHIPROCKET_PASSWORD",
      // Webhook HMAC secret — without it Shiprocket shipment webhooks are rejected.
      "SHIPROCKET_WEBHOOK_SECRET",
      "ANTHROPIC_API_KEY",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      // S3 media: on AWS the app authenticates with the ECS TASK ROLE (which has
      // grantReadWrite + KMS encrypt/decrypt on the bucket) — no static keys. For
      // an external R2/MinIO bucket set S3_ENDPOINT + S3_ACCESS_KEY_ID/SECRET in
      // the app secret and add them back here instead.
      "S3_PUBLIC_BASE_URL",
      // Server-side Sentry DSN (user-supplied secret; drives error reporting in
      // web + worker + migrate). SENTRY_ENVIRONMENT is set as plain env above.
      "SENTRY_DSN",
    ] as const;

    const env: Record<string, ecs.Secret> = {};
    for (const key of appKeys) {
      env[key] = ecs.Secret.fromSecretsManager(data.appSecret, key);
    }
    // DB: Prisma wants a single URL. Store DATABASE_URL/DIRECT_URL as keys in
    // the app secret (pooled + direct); RDS-managed creds also available.
    env.DATABASE_URL = ecs.Secret.fromSecretsManager(data.appSecret, "DATABASE_URL");
    env.DIRECT_URL = ecs.Secret.fromSecretsManager(data.appSecret, "DIRECT_URL");
    env.REDIS_URL = ecs.Secret.fromSecretsManager(data.appSecret, "REDIS_URL");
    return env;
  }

  private addAlarms(stage: string): sns.Topic {
    // SNS topic every alarm publishes to. Subscribe an on-call endpoint by
    // passing `-c alarmEmail=ops@example.com` (the address must confirm the
    // subscription email SNS sends). Without it the topic exists but has no
    // subscribers — wire PagerDuty/Slack/etc. to it later.
    const topic = new sns.Topic(this, "AlarmTopic", {
      displayName: `shezmin-${stage} alarms`,
    });
    const alarmEmail = this.node.tryGetContext("alarmEmail");
    if (typeof alarmEmail === "string" && alarmEmail.length > 0) {
      topic.addSubscription(new snsSubscriptions.EmailSubscription(alarmEmail));
    }
    const action = new cwActions.SnsAction(topic);

    const alarmify = (id: string, metric: cloudwatch.IMetric, threshold: number, desc: string) => {
      const alarm = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `[shezmin-${stage}] ${desc}`,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      return alarm;
    };

    alarmify("WebCpuHigh", this.webService.metricCpuUtilization(), 80, "web CPU >= 80%");
    alarmify("WebMemHigh", this.webService.metricMemoryUtilization(), 85, "web memory >= 85%");
    alarmify("WorkerCpuHigh", this.workerService.metricCpuUtilization(), 80, "worker CPU >= 80%");

    // 5xx from the ALB target group.
    const http5xx = this.alb.metrics.httpCodeTarget(
      elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
      { period: Duration.minutes(1), statistic: "Sum" },
    );
    alarmify("Alb5xx", http5xx, 10, "ALB target 5xx >= 10/min");

    return topic;
  }
}

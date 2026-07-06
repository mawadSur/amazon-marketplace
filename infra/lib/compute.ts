// Compute layer: ECR repos, ECS Fargate cluster, web service (behind an
// internal ALB, health check /api/health), worker service (no ports), a
// one-off migrate task definition, least-privilege roles, and CloudWatch alarms.

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
  readonly appPort = 3000;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);
    const { vpc, data, stage } = props;

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
    data.dbSecret.grantRead(executionRole);
    data.redisAuthSecret.grantRead(executionRole);

    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    data.mediaBucket.grantReadWrite(taskRole);
    data.mediaKey.grantEncryptDecrypt(taskRole);
    data.appSecret.grantRead(taskRole);

    // --- Shared secret env mapping -------------------------------------
    const secretEnv = this.buildSecretEnv(data);
    const commonEnv = {
      NODE_ENV: "production",
      AWS_REGION: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
      S3_BUCKET: data.mediaBucket.bucketName,
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
      image: ecs.ContainerImage.fromEcrRepository(this.webRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup }),
      environment: { ...commonEnv, PORT: String(this.appPort) },
      secrets: secretEnv,
      portMappings: [{ containerPort: this.appPort }],
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
      healthCheck: {
        path: "/api/health",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(15),
    });

    // App tasks may reach DB/Redis; DB/Redis only accept from app SGs.
    data.db.connections.allowFrom(webSg, ec2.Port.tcp(5432), "web -> postgres");
    data.redisSecurityGroup.addIngressRule(webSg, ec2.Port.tcp(6379), "web -> redis");

    // --- Worker task + service (no ingress) ----------------------------
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
    });
    workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromEcrRepository(this.workerRepo, "latest"),
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
    data.db.connections.allowFrom(workerSg, ec2.Port.tcp(5432), "worker -> postgres");
    data.redisSecurityGroup.addIngressRule(workerSg, ec2.Port.tcp(6379), "worker -> redis");

    // --- One-off migrate task (used by deploy.yml release step) ---------
    // Reuses the worker image (ships prisma CLI + schema). Command overridden
    // at run-task time to `npx prisma migrate deploy`.
    this.migrateTask = new ecs.FargateTaskDefinition(this, "MigrateTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
    });
    this.migrateTask.addContainer("migrate", {
      image: ecs.ContainerImage.fromEcrRepository(this.workerRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "migrate", logGroup }),
      environment: commonEnv,
      secrets: secretEnv,
      command: ["npx", "prisma", "migrate", "deploy"],
    });

    this.webSecurityGroup = webSg;
    this.addAlarms(props.stage);
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
      "KYC_PROVIDER_API_KEY",
      "KYC_PROVIDER_BASE_URL",
      "SHIPROCKET_EMAIL",
      "SHIPROCKET_PASSWORD",
      "ANTHROPIC_API_KEY",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_PUBLIC_BASE_URL",
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

  private addAlarms(stage: string): void {
    const alarmify = (id: string, metric: cloudwatch.IMetric, threshold: number, desc: string) =>
      new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `[shezmin-${stage}] ${desc}`,
      });

    alarmify("WebCpuHigh", this.webService.metricCpuUtilization(), 80, "web CPU >= 80%");
    alarmify("WebMemHigh", this.webService.metricMemoryUtilization(), 85, "web memory >= 85%");
    alarmify("WorkerCpuHigh", this.workerService.metricCpuUtilization(), 80, "worker CPU >= 80%");

    // 5xx from the ALB target group.
    const http5xx = this.alb.metrics.httpCodeTarget(
      elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
      { period: Duration.minutes(1), statistic: "Sum" },
    );
    alarmify("Alb5xx", http5xx, 10, "ALB target 5xx >= 10/min");
  }
}

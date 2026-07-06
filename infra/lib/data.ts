// Stateful layer: RDS Postgres, ElastiCache Redis (TLS), S3 media bucket
// (Block Public Access + KMS), and the app secret in Secrets Manager.

import { Construct } from "constructs";
import {
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_rds as rds,
  aws_elasticache as elasticache,
  aws_s3 as s3,
  aws_kms as kms,
  aws_secretsmanager as secrets,
} from "aws-cdk-lib";

export interface DataProps {
  readonly vpc: ec2.Vpc;
  readonly stage: string;
}

export class Data extends Construct {
  readonly db: rds.DatabaseInstance;
  readonly dbSecret: secrets.ISecret;
  readonly redis: elasticache.CfnReplicationGroup;
  readonly redisSecurityGroup: ec2.SecurityGroup;
  readonly redisAuthSecret: secrets.Secret;
  readonly mediaBucket: s3.Bucket;
  readonly mediaKey: kms.Key;
  /** Aggregated non-DB app secrets (Stripe, Razorpay, Twilio, ...). */
  readonly appSecret: secrets.Secret;

  constructor(scope: Construct, id: string, props: DataProps) {
    super(scope, id);
    const { vpc, stage } = props;

    // --- KMS key for media at rest -------------------------------------
    this.mediaKey = new kms.Key(this, "MediaKey", {
      enableKeyRotation: true,
      description: `shezmin-${stage} media bucket CMK`,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- S3 media bucket: private, encrypted, TLS-only -----------------
    this.mediaBucket = new s3.Bucket(this, "MediaBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.mediaKey,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
        {
          noncurrentVersionExpiration: Duration.days(30),
          noncurrentVersionsToRetain: 3,
        },
      ],
    });

    // --- RDS Postgres --------------------------------------------------
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "RDS Postgres — ingress only from app tasks",
      allowAllOutbound: false,
    });
    this.db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MEDIUM,
      ),
      allocatedStorage: 50,
      maxAllocatedStorage: 200,
      storageEncrypted: true,
      multiAz: stage === "prod",
      backupRetention: Duration.days(stage === "prod" ? 14 : 3),
      deletionProtection: stage === "prod",
      removalPolicy: RemovalPolicy.RETAIN,
      credentials: rds.Credentials.fromGeneratedSecret("shezmin_app"),
      databaseName: "shezmin",
      cloudwatchLogsExports: ["postgresql"],
    });
    this.dbSecret = this.db.secret!;

    // --- ElastiCache Redis (TLS + AUTH) --------------------------------
    this.redisSecurityGroup = new ec2.SecurityGroup(this, "RedisSg", {
      vpc,
      description: "ElastiCache Redis — ingress only from app tasks",
      allowAllOutbound: false,
    });
    const redisSubnets = new elasticache.CfnSubnetGroup(this, "RedisSubnets", {
      description: "Redis private-isolated subnets",
      subnetIds: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }).subnetIds,
    });
    // AUTH token — ElastiCache requires 16-128 chars, no ambiguous symbols.
    this.redisAuthSecret = new secrets.Secret(this, "RedisAuth", {
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        excludeCharacters: '"@/\\',
      },
    });
    this.redis = new elasticache.CfnReplicationGroup(this, "Redis", {
      replicationGroupDescription: `shezmin-${stage} redis`,
      engine: "redis",
      cacheNodeType: "cache.t4g.small",
      numNodeGroups: 1,
      replicasPerNodeGroup: stage === "prod" ? 1 : 0,
      automaticFailoverEnabled: stage === "prod",
      multiAzEnabled: stage === "prod",
      transitEncryptionEnabled: true, // TLS in transit
      atRestEncryptionEnabled: true,
      authToken: this.redisAuthSecret.secretValue.unsafeUnwrap(),
      cacheSubnetGroupName: redisSubnets.ref,
      securityGroupIds: [this.redisSecurityGroup.securityGroupId],
      port: 6379,
    });
    this.redis.addDependency(redisSubnets);

    // --- Aggregated app secret ----------------------------------------
    // Provisioned with placeholder keys; the human fills real values via the
    // console/CLI post-deploy. Task defs read individual keys from here.
    this.appSecret = new secrets.Secret(this, "AppSecret", {
      description: `shezmin-${stage} application secrets (fill after deploy)`,
      secretObjectValue: {},
    });
  }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_ATTEMPTS = 5;

export class WalletStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    // ---- Database ----
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Postgres' });
    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromGeneratedSecret('wallet'),
      databaseName: 'wallet',
      securityGroups: [dbSg],
      allocatedStorage: 20,
      backupRetention: Duration.days(7),
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    // ---- Redis ----
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'Redis' });
    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'Redis subnets',
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });
    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnets.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });
    const redisUrl = `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // ---- Queues ----
    const dlq = new sqs.Queue(this, 'EventsDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, 'Events', {
      visibilityTimeout: Duration.seconds(30),
      enforceSSL: true,
      // Safety net: the worker dead-letters in the database after MAX_ATTEMPTS, before SQS would.
      deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_ATTEMPTS + 1 },
    });

    const jwtSecret = new secrets.Secret(this, 'JwtSecret', {
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // ---- ECS ----
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });
    const dbUrlSecret = (secret: secrets.ISecret) => ({
      DB_HOST: ecs.Secret.fromSecretsManager(secret, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(secret, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(secret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'password'),
    });

    const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(repoRoot, { file: 'apps/api/Dockerfile' }),
        containerPort: 3000,
        environment: {
          NODE_ENV: 'production',
          DB_NAME: 'wallet',
          REDIS_URL: redisUrl,
          LOG_LEVEL: 'info',
        },
        secrets: {
          ...dbUrlSecret(db.secret!),
          JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'api',
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      },
    });
    api.targetGroup.configureHealthCheck({ path: '/health', healthyHttpCodes: '200' });
    // WebSocket connections are long-lived.
    api.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');

    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    workerTask.addContainer('worker', {
      image: ecs.ContainerImage.fromAsset(repoRoot, { file: 'apps/worker/Dockerfile' }),
      environment: {
        NODE_ENV: 'production',
        DB_NAME: 'wallet',
        REDIS_URL: redisUrl,
        SQS_QUEUE_URL: queue.queueUrl,
        SQS_DLQ_URL: dlq.queueUrl,
        AWS_REGION: this.region,
        MAX_ATTEMPTS: String(MAX_ATTEMPTS),
      },
      secrets: dbUrlSecret(db.secret!),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'worker',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
    });
    const worker = new ecs.FargateService(this, 'Worker', {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    queue.grantConsumeMessages(workerTask.taskRole);
    queue.grantSendMessages(workerTask.taskRole);
    dlq.grantConsumeMessages(workerTask.taskRole);

    for (const svc of [api.service, worker]) {
      for (const conn of svc.connections.securityGroups) {
        dbSg.addIngressRule(conn, ec2.Port.tcp(5432), 'app to Postgres');
        redisSg.addIngressRule(conn, ec2.Port.tcp(6379), 'app to Redis');
      }
    }

    new CfnOutput(this, 'ApiUrl', { value: `http://${api.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
  }
}

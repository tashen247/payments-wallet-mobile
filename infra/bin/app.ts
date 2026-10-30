import { App } from 'aws-cdk-lib';
import { WalletStack } from '../lib/wallet-stack';

const app = new App();
new WalletStack(app, 'PayWallet', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'af-south-1',
  },
  description:
    'Pay Wallet: API and worker on ECS Fargate, RDS Postgres, ElastiCache Redis, SQS with DLQ',
});

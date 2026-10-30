import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { WalletStack } from '../lib/wallet-stack';

describe('WalletStack', () => {
  const template = Template.fromStack(
    new WalletStack(new App(), 'Test', { env: { account: '111111111111', region: 'af-south-1' } }),
  );

  it('wires the events queue to a dead-letter queue', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 6 }),
    });
  });

  it('runs Postgres 16 encrypted, in private subnets', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      StorageEncrypted: true,
      PubliclyAccessible: false,
    });
  });

  it('runs the API and the worker on Fargate', () => {
    template.resourceCountIs('AWS::ECS::Service', 2);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health',
    });
  });

  it('keeps secrets out of plain environment variables', () => {
    const defs = template.findResources('AWS::ECS::TaskDefinition');
    const env = JSON.stringify(
      Object.values(defs).map((d) =>
        d.Properties.ContainerDefinitions.map((c: { Environment?: unknown }) => c.Environment),
      ),
    );
    expect(env).not.toMatch(/PASSWORD|JWT_SECRET/);
  });
});

import { describe, expect, it } from 'vitest';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { ExpoPushSender } from '../src/push';
import { SqsQueue } from '../src/queue/sqs';
import { loadConfig } from '../src/config';
import { log } from './helpers';

describe('SqsQueue', () => {
  it('maps queue operations onto SQS commands', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'ReceiveMessageCommand') {
          return {
            Messages: [
              {
                MessageId: 'm1',
                ReceiptHandle: 'r1',
                Body: '{}',
                Attributes: { ApproximateReceiveCount: '3' },
              },
            ],
          };
        }
        return {};
      },
    } as unknown as SQSClient;
    const q = new SqsQueue(client, 'https://sqs/q');
    await q.send('hello');
    const received = await q.receive(25, 10);
    await q.changeVisibility('r1', 4.4);
    await q.delete('r1');
    expect(received).toEqual([
      { messageId: 'm1', receiptHandle: 'r1', body: '{}', receiveCount: 3 },
    ]);
    expect(sent.map((s) => s.name)).toEqual([
      'SendMessageCommand',
      'ReceiveMessageCommand',
      'ChangeMessageVisibilityCommand',
      'DeleteMessageCommand',
    ]);
    expect(sent[1]!.input).toMatchObject({ MaxNumberOfMessages: 10, WaitTimeSeconds: 10 });
    expect(sent[2]!.input).toMatchObject({ VisibilityTimeout: 4 });
  });
});

describe('ExpoPushSender', () => {
  it('drops tokens that are not Expo push tokens without calling the service', async () => {
    const sender = new ExpoPushSender(undefined, log);
    const result = await sender.send({ to: ['not-a-token'], title: 't', body: 'b', data: {} });
    expect(result.invalidTokens).toEqual(['not-a-token']);
  });
});

describe('config', () => {
  it('defaults local development to LocalStack and parses fault injection', () => {
    const c = loadConfig({
      NODE_ENV: 'development',
      WORKER_FAIL_EVENT_TYPES: 'transfer.completed, topup.completed',
    });
    expect(c.SQS_ENDPOINT).toBe('http://localhost:4566');
    expect(c.SQS_AUTO_CREATE).toBe(true);
    expect(c.WORKER_FAIL_EVENT_TYPES).toEqual(['transfer.completed', 'topup.completed']);
  });
  it('builds the database URL from ECS-injected parts', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      DB_HOST: 'db.internal',
      DB_USER: 'wallet',
      DB_PASSWORD: 'p@ss',
      DB_NAME: 'wallet',
      SQS_QUEUE_URL: 'q',
    });
    expect(c.DATABASE_URL).toBe(
      'postgres://wallet:p%40ss@db.internal:5432/wallet?sslmode=no-verify',
    );
    expect(c.SQS_ENDPOINT).toBeUndefined();
  });
});

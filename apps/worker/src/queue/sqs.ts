import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { WorkerConfig } from '../config';
import type { Queue, ReceivedMessage } from './types';

export class SqsQueue implements Queue {
  constructor(
    private readonly client: SQSClient,
    readonly url: string,
  ) {}

  async send(body: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.url, MessageBody: body }));
  }

  async receive(max: number, waitSeconds: number): Promise<ReceivedMessage[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: Math.min(max, 10),
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      messageId: m.MessageId!,
      receiptHandle: m.ReceiptHandle!,
      body: m.Body ?? '',
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
    }));
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.url,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.round(seconds),
      }),
    );
  }
}

export async function createSqsQueues(
  config: WorkerConfig,
): Promise<{ main: SqsQueue; dlq: SqsQueue }> {
  const client = new SQSClient({
    region: config.AWS_REGION,
    ...(config.SQS_ENDPOINT
      ? {
          endpoint: config.SQS_ENDPOINT,
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        }
      : {}),
  });
  const urlFor = async (
    name: string,
    explicit: string | undefined,
    attributes?: Record<string, string>,
  ) => {
    if (explicit) return explicit;
    if (config.SQS_AUTO_CREATE) {
      const res = await client.send(
        new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
      );
      return res.QueueUrl!;
    }
    return (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  };
  const dlqUrl = await urlFor(config.SQS_DLQ_NAME, config.SQS_DLQ_URL);
  let mainAttributes: Record<string, string> | undefined;
  if (config.SQS_AUTO_CREATE) {
    const attrs = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    mainAttributes = {
      VisibilityTimeout: '30',
      // Safety net only: the worker dead-letters in the database after MAX_ATTEMPTS, before SQS would.
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: attrs.Attributes!.QueueArn,
        maxReceiveCount: String(config.MAX_ATTEMPTS + 1),
      }),
    };
  }
  const mainUrl = await urlFor(config.SQS_QUEUE_NAME, config.SQS_QUEUE_URL, mainAttributes);
  return { main: new SqsQueue(client, mainUrl), dlq: new SqsQueue(client, dlqUrl) };
}

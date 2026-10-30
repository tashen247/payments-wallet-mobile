import { randomUUID } from 'node:crypto';
import type { Queue, ReceivedMessage } from './types';

interface Stored {
  messageId: string;
  body: string;
  receiveCount: number;
  visibleAt: number;
  receiptHandle: string | null;
}

/**
 * In-process queue with SQS semantics that matter here: visibility timeout, receive counts and a
 * redrive to a dead-letter queue after maxReceiveCount. Used in tests and for running locally
 * without LocalStack.
 */
export class MemoryQueue implements Queue {
  private messages: Stored[] = [];

  constructor(
    private readonly opts: {
      visibilitySeconds?: number;
      maxReceiveCount?: number;
      deadLetter?: MemoryQueue;
    } = {},
  ) {}

  async send(body: string): Promise<void> {
    this.messages.push({
      messageId: randomUUID(),
      body,
      receiveCount: 0,
      visibleAt: 0,
      receiptHandle: null,
    });
  }

  async receive(max: number, waitSeconds: number): Promise<ReceivedMessage[]> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const out = this.take(max);
      if (out.length || Date.now() >= deadline) return out;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private take(max: number): ReceivedMessage[] {
    const now = Date.now();
    const out: ReceivedMessage[] = [];
    for (const m of [...this.messages]) {
      if (out.length >= max) break;
      if (m.visibleAt > now) continue;
      if (this.opts.maxReceiveCount && m.receiveCount >= this.opts.maxReceiveCount) {
        this.messages = this.messages.filter((x) => x !== m);
        void this.opts.deadLetter?.send(m.body);
        continue;
      }
      m.receiveCount += 1;
      m.receiptHandle = randomUUID();
      m.visibleAt = now + (this.opts.visibilitySeconds ?? 30) * 1000;
      out.push({
        messageId: m.messageId,
        receiptHandle: m.receiptHandle,
        body: m.body,
        receiveCount: m.receiveCount,
      });
    }
    return out;
  }

  async delete(receiptHandle: string): Promise<void> {
    this.messages = this.messages.filter((m) => m.receiptHandle !== receiptHandle);
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    const m = this.messages.find((x) => x.receiptHandle === receiptHandle);
    if (m) m.visibleAt = Date.now() + seconds * 1000;
  }

  size(): number {
    return this.messages.length;
  }
}

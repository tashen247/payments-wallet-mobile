export interface ReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** How many times this message has been received, including this time (1 on first delivery). */
  receiveCount: number;
}

/** The subset of queue behaviour the worker needs; implemented by SQS and an in-memory queue. */
export interface Queue {
  send(body: string): Promise<void>;
  receive(max: number, waitSeconds: number): Promise<ReceivedMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  /** Hide the message for this long before it can be received again (used for retry backoff). */
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>;
}

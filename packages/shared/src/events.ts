import { z } from 'zod';

/** Events written to the outbox in the same database transaction as the change they describe. */
export const OutboxEventType = z.enum([
  'transfer.completed',
  'topup.completed',
  'payment_request.created',
  'payment_request.declined',
]);
export type OutboxEventType = z.infer<typeof OutboxEventType>;

export const NotifyTarget = z.object({
  userId: z.uuid(),
  push: z.object({ title: z.string(), body: z.string() }).nullable(),
});

export const OutboxPayload = z.object({
  transactionId: z.uuid().optional(),
  paymentRequestId: z.uuid().optional(),
  amountCents: z.number().int(),
  targets: z.array(NotifyTarget),
});
export type OutboxPayload = z.infer<typeof OutboxPayload>;

/** Message envelope on the queue. */
export const QueueMessage = z.object({
  eventId: z.uuid(),
  type: OutboxEventType,
  correlationId: z.string().nullable(),
  payload: OutboxPayload,
});
export type QueueMessage = z.infer<typeof QueueMessage>;

/** Messages pushed to the app over the WebSocket. */
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), userId: z.uuid() }),
  z.object({
    type: z.literal('wallet.changed'),
    eventType: OutboxEventType,
    transactionId: z.uuid().nullable(),
    paymentRequestId: z.uuid().nullable(),
    amountCents: z.number().int(),
  }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

export const wsChannelForUser = (userId: string) => `ws:user:${userId}`;

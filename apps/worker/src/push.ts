import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { Logger } from 'pino';

export interface PushMessage {
  to: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface PushResult {
  /** Tokens Expo reports as no longer registered; the caller removes them. */
  invalidTokens: string[];
}

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}

export class ExpoPushSender implements PushSender {
  private readonly expo: Expo;

  constructor(
    accessToken: string | undefined,
    private readonly log: Logger,
  ) {
    this.expo = new Expo(accessToken ? { accessToken } : {});
  }

  async send(message: PushMessage): Promise<PushResult> {
    const valid = message.to.filter((t) => Expo.isExpoPushToken(t));
    const invalidTokens: string[] = message.to.filter((t) => !Expo.isExpoPushToken(t));
    const messages: ExpoPushMessage[] = valid.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: message.data,
      sound: 'default',
    }));
    for (const chunk of this.expo.chunkPushNotifications(messages)) {
      // Throws on network or server errors, so the event is retried.
      const tickets = await this.expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          const token = (chunk[i]?.to as string) ?? 'unknown';
          if (ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(token);
          else this.log.warn({ token, error: ticket.message }, 'push ticket error');
        }
      });
    }
    return { invalidTokens };
  }
}

/** Records pushes instead of sending them: used in tests and when PUSH_DRIVER=log. */
export class RecordingPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  constructor(private readonly log?: Logger) {}
  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    this.log?.info({ to: message.to, title: message.title }, 'push (log driver)');
    return { invalidTokens: [] };
  }
}

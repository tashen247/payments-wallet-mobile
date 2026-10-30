import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Fans WebSocket messages out across API instances. The worker publishes to ws:user:<id> on Redis;
 * every API instance subscribes to the pattern and forwards to the sockets it holds for that user.
 */
export class WsHub {
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly sub: Redis,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    this.sub.on('pmessage', (_pattern, channel, message) => {
      const userId = channel.slice('ws:user:'.length);
      const set = this.sockets.get(userId);
      if (!set) return;
      for (const socket of set) if (socket.readyState === socket.OPEN) socket.send(message);
    });
    await this.sub.psubscribe('ws:user:*');
  }

  add(userId: string, socket: WebSocket): void {
    let set = this.sockets.get(userId);
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(socket);
    socket.on('close', () => {
      set.delete(socket);
      if (set.size === 0) this.sockets.delete(userId);
    });
    this.log.debug({ userId, connections: set.size }, 'ws connected');
  }

  connectionCount(): number {
    let n = 0;
    for (const s of this.sockets.values()) n += s.size;
    return n;
  }

  async stop(): Promise<void> {
    for (const set of this.sockets.values())
      for (const s of set) s.close(1001, 'server shutting down');
    await this.sub.punsubscribe('ws:user:*');
  }
}

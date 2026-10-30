import type { FastifyPluginAsync } from 'fastify';
import type { WsServerMessage } from '@wallet/shared';
import type { TokenUser } from '../plugins/auth';
import type { WsHub } from '../ws/hub';

/**
 * Authenticated WebSocket. The access token travels in the query string because React Native's
 * WebSocket cannot set an Authorization header on every platform; tokens are short-lived.
 */
export const wsRoutes: FastifyPluginAsync<{ hub: WsHub }> = async (app, { hub }) => {
  app.get('/v1/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    let user: TokenUser;
    try {
      user = app.jwt.verify<TokenUser>(token ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    hub.add(user.sub, socket);
    const hello: WsServerMessage = { type: 'hello', userId: user.sub };
    socket.send(JSON.stringify(hello));
    socket.on('message', (raw) => {
      if (raw.toString() === 'ping') socket.send('pong');
    });
  });
};

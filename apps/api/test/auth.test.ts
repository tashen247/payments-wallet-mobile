import { describe, expect, it } from 'vitest';
import { auth, registerUser, useHarness } from './helpers';

describe('auth', () => {
  const h = useHarness();

  it('registers a user with a ZAR account and zero balance', async () => {
    const user = await registerUser(h, 'Thandi Nkosi');
    const wallet = await h.app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: auth(user.token),
    });
    expect(wallet.json()).toMatchObject({
      currency: 'ZAR',
      balanceCents: 0,
      frozen: false,
      dailyLimitCents: 500_000,
      sentTodayCents: 0,
    });
  });

  it('rejects a duplicate email', async () => {
    const payload = {
      email: 'dup@example.co.za',
      phone: '0821110000',
      displayName: 'Dup',
      password: 'password123',
    };
    expect(
      (await h.app.inject({ method: 'POST', url: '/v1/auth/register', payload })).statusCode,
    ).toBe(201);
    const again = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { ...payload, phone: '0821110001' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('EMAIL_TAKEN');
  });

  it('validates input with the shared schemas', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'nope', phone: '1', displayName: 'X', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('logs in and rejects a wrong password', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'sipho@example.co.za',
        phone: '0831234567',
        displayName: 'Sipho',
        password: 'password123',
      },
    });
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'SIPHO@example.co.za', password: 'password123' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.displayName).toBe('Sipho');
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'sipho@example.co.za', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('rotates refresh tokens and revokes every session when an old token is reused', async () => {
    const user = await registerUser(h);
    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const next = first.json().refreshToken as string;
    expect(next).not.toBe(user.refreshToken);

    const reuse = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    // The reuse revoked the newer token too.
    const after = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: next },
    });
    expect(after.statusCode).toBe(401);
  });

  it('requires a valid access token', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/wallet' })).statusCode).toBe(401);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: '/v1/wallet',
          headers: { authorization: 'Bearer junk' },
        })
      ).statusCode,
    ).toBe(401);
    const user = await registerUser(h, 'Lerato');
    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: auth(user.token) });
    expect(me.json()).toMatchObject({ displayName: 'Lerato', role: 'holder' });
  });

  it('serves health, a correlation id and the OpenAPI docs', async () => {
    const health = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'abc-123' },
    });
    expect(health.json().status).toBe('ok');
    expect(health.headers['x-correlation-id']).toBe('abc-123');
    const spec = await h.app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(Object.keys(spec.json().paths)).toContain('/v1/transfers');
  });
});

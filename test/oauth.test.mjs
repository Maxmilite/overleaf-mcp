import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { FeishuOAuthProvider } from '../src/oauth.mjs';

const s256 = (v) => createHash('sha256').update(v).digest('base64url');

/** Minimal stand-in for an Express response, capturing what the provider emits. */
const fakeRes = () => {
  const res = {
    statusCode: 200,
    redirectTo: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
    send(b) {
      res.body = b;
      return res;
    },
    type() {
      return res;
    },
    redirect(url) {
      res.redirectTo = url;
      return res;
    },
  };
  return res;
};

const withFakeFeishu = (openId, fn) => async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/authen/v2/oauth/token')) {
      return { json: async () => ({ access_token: 'feishu-access-token' }) };
    }
    if (String(url).includes('/authen/v1/user_info')) {
      return { json: async () => ({ code: 0, data: { open_id: openId, name: 'Test User' } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const setup = async (allowedOpenIds = ['ou_test']) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'olmcp-'));
  const provider = new FeishuOAuthProvider({
    publicUrl: 'https://ol.example.test',
    appId: 'cli_test',
    appSecret: 'secret',
    allowedOpenIds,
    stateDir: dir,
  });
  const client = await provider.clientsStore.registerClient({
    redirect_uris: ['https://chat.example/callback'],
    client_name: 'ChatGPT',
  });
  return { provider, client, dir };
};

const authorize = async (provider, client, extra = {}) => {
  const verifier = randomBytes(32).toString('base64url');
  const res = fakeRes();
  await provider.authorize(
    client,
    {
      redirectUri: 'https://chat.example/callback',
      codeChallenge: s256(verifier),
      scopes: [],
      state: 'client-state-1',
      ...extra,
    },
    res,
  );
  return { res, verifier };
};

test('authorize redirects to Feishu and keeps the client state separate', async () => {
  const { provider, client, dir } = await setup();
  const { res } = await authorize(provider, client);
  const url = new URL(res.redirectTo);

  assert.equal(url.origin + url.pathname, 'https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cli_test');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://ol.example.test/callback');
  assert.notEqual(url.searchParams.get('state'), 'client-state-1', 'Feishu state must be opaque, not the client state');

  await rm(dir, { recursive: true, force: true });
});

test('authorize rejects an unregistered redirect_uri', async () => {
  const { provider, client, dir } = await setup();
  const res = fakeRes();
  await provider.authorize(client, { redirectUri: 'https://evil.example/cb', codeChallenge: 'x', scopes: [] }, res);
  assert.equal(res.statusCode, 400);
  await rm(dir, { recursive: true, force: true });
});

test('full flow: callback mints a code, token verifies PKCE, access token works', async () => {
  const { provider, client, dir } = await setup();

  await withFakeFeishu('ou_test', async () => {
    const { res, verifier } = await authorize(provider, client);
    const feishuState = new URL(res.redirectTo).searchParams.get('state');

    const cbRes = fakeRes();
    await provider.handleCallback({ query: { code: 'feishu-code', state: feishuState } }, cbRes);

    const back = new URL(cbRes.redirectTo);
    assert.equal(back.origin + back.pathname, 'https://chat.example/callback');
    assert.equal(back.searchParams.get('state'), 'client-state-1', 'client gets its own state back');
    const code = back.searchParams.get('code');

    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, 'https://chat.example/callback');
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.refresh_token);

    const info = await provider.verifyAccessToken(tokens.access_token);
    assert.equal(info.clientId, client.client_id);

    // Authorization codes are single use.
    await assert.rejects(
      () => provider.exchangeAuthorizationCode(client, code, verifier, 'https://chat.example/callback'),
      /unknown or already used/,
    );

    // Refresh rotates and invalidates the old refresh token.
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token);
    assert.ok(refreshed.access_token);
    await assert.rejects(() => provider.exchangeRefreshToken(client, tokens.refresh_token), /unknown or expired/);
  });

  await rm(dir, { recursive: true, force: true });
});

test('a wrong code_verifier is rejected', async () => {
  const { provider, client, dir } = await setup();
  await withFakeFeishu('ou_test', async () => {
    const { res, verifier } = await authorize(provider, client);
    const cbRes = fakeRes();
    await provider.handleCallback({ query: { code: 'c', state: new URL(res.redirectTo).searchParams.get('state') } }, cbRes);
    const code = new URL(cbRes.redirectTo).searchParams.get('code');
    await assert.rejects(
      () => provider.exchangeAuthorizationCode(client, code, verifier + 'x', 'https://chat.example/callback'),
      /PKCE/,
    );
  });
  await rm(dir, { recursive: true, force: true });
});

test('an identity outside the allow-list is refused', async () => {
  const { provider, client, dir } = await setup(['ou_someone_else']);
  await withFakeFeishu('ou_intruder', async () => {
    const { res } = await authorize(provider, client);
    const cbRes = fakeRes();
    await provider.handleCallback({ query: { code: 'c', state: new URL(res.redirectTo).searchParams.get('state') } }, cbRes);
    assert.equal(cbRes.statusCode, 403);
    assert.equal(cbRes.redirectTo, null);
  });
  await rm(dir, { recursive: true, force: true });
});

test('replaying a used callback state is refused', async () => {
  const { provider, client, dir } = await setup();
  await withFakeFeishu('ou_test', async () => {
    const { res } = await authorize(provider, client);
    const state = new URL(res.redirectTo).searchParams.get('state');
    await provider.handleCallback({ query: { code: 'c', state } }, fakeRes());
    const replay = fakeRes();
    await provider.handleCallback({ query: { code: 'c', state } }, replay);
    assert.equal(replay.statusCode, 400);
  });
  await rm(dir, { recursive: true, force: true });
});

test('tokens survive a restart', async () => {
  const { provider, client, dir } = await setup();
  await withFakeFeishu('ou_test', async () => {
    const { res, verifier } = await authorize(provider, client);
    const cbRes = fakeRes();
    await provider.handleCallback({ query: { code: 'c', state: new URL(res.redirectTo).searchParams.get('state') } }, cbRes);
    const code = new URL(cbRes.redirectTo).searchParams.get('code');
    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, 'https://chat.example/callback');

    const restarted = new FeishuOAuthProvider({
      publicUrl: 'https://ol.example.test',
      appId: 'cli_test',
      appSecret: 'secret',
      allowedOpenIds: ['ou_test'],
      stateDir: dir,
    });
    const info = await restarted.verifyAccessToken(tokens.access_token);
    assert.equal(info.clientId, client.client_id);
    assert.ok(await restarted.clientsStore.getClient(client.client_id), 'registered clients persist too');
  });
  await rm(dir, { recursive: true, force: true });
});

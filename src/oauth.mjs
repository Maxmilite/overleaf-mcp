import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

/**
 * An OAuth 2.1 authorization server whose only identity provider is Feishu.
 *
 * Why not just proxy Feishu's OAuth? Because then Feishu owns the access token,
 * every refresh needs Feishu, and the MCP server has no way to say "this token
 * is mine and expires when I say". Here Feishu only answers one question — "who
 * is this, really" — and everything else (client registration, PKCE, codes,
 * access and refresh tokens) is local and inspectable.
 *
 *   /authorize  ->  302 to Feishu's login
 *   Feishu      ->  302 back to /callback?code=...
 *   /callback   ->  exchange the Feishu code, check the identity, mint our own
 *                   authorization code, 302 to the client's redirect_uri
 *   /token      ->  verify PKCE, issue our own access + refresh token
 */

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TTL_S = 60 * 60 * 24; // 24h
const DEFAULT_REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30d

const now = () => Date.now();
const token = () => randomBytes(32).toString('base64url');
const s256 = (verifier) => createHash('sha256').update(verifier).digest('base64url');

class Store {
  constructor(file) {
    this.file = file;
    this.data = { clients: {}, pending: {}, codes: {}, access: {}, refresh: {} };
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        clients: parsed.clients ?? {},
        pending: parsed.pending ?? {},
        codes: parsed.codes ?? {},
        access: parsed.access ?? {},
        refresh: parsed.refresh ?? {},
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  /** Persist outside the caller's control flow so failures surface loudly. */
  save() {
    const snapshot = JSON.stringify(this.data);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file, snapshot, { mode: 0o600 });
      await chmod(this.file, 0o600);
    });
    return this.writeChain;
  }

  prune() {
    const t = now();
    for (const [k, v] of Object.entries(this.data.pending)) if (v.expiresAt < t) delete this.data.pending[k];
    for (const [k, v] of Object.entries(this.data.codes)) if (v.expiresAt < t) delete this.data.codes[k];
    for (const [k, v] of Object.entries(this.data.access)) if (v.expiresAt < t) delete this.data.access[k];
    for (const [k, v] of Object.entries(this.data.refresh)) if (v.expiresAt < t) delete this.data.refresh[k];
  }
}

export class FeishuOAuthProvider {
  constructor({ publicUrl, appId, appSecret, allowedOpenIds = [], stateDir, accessTtlSec, log = () => {} }) {
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.appId = appId;
    this.appSecret = appSecret;
    this.allowedOpenIds = new Set(allowedOpenIds.filter(Boolean));
    this.accessTtlSec = accessTtlSec ?? DEFAULT_ACCESS_TTL_S;
    this.log = log;
    this.store = new Store(path.join(stateDir, 'oauth.json'));
    this.ready = this.store.load();
    this.clientsStore = {
      getClient: (clientId) => this.store.data.clients[clientId],
      registerClient: async (client) => {
        const clientId = `mcp_${token()}`;
        const record = { ...client, client_id: clientId, client_id_issued_at: Math.floor(now() / 1000) };
        if (!record.token_endpoint_auth_method) record.token_endpoint_auth_method = 'none';
        this.store.data.clients[clientId] = record;
        await this.store.save();
        this.log(`registered client ${clientId} (${(client.redirect_uris ?? []).join(', ')})`);
        return record;
      },
    };

    if (!this.allowedOpenIds.size) {
      this.log('WARNING: ALLOWED_OPEN_ID is empty — any Feishu account that can reach the app will be able to authorize');
    }
  }

  // -- Feishu helpers -------------------------------------------------------

  async feishuIdentity(code) {
    const body = {
      grant_type: 'authorization_code',
      client_id: this.appId,
      client_secret: this.appSecret,
      code,
      redirect_uri: `${this.publicUrl}/callback`,
    };
    const res = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.access_token) {
      throw new Error(`Feishu token exchange failed: ${json.error_description || json.msg || JSON.stringify(json).slice(0, 300)}`);
    }

    const info = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${json.access_token}` },
    });
    const user = await info.json();
    if (user.code !== 0 || !user.data?.open_id) {
      throw new Error(`Feishu user_info failed: ${user.msg || JSON.stringify(user).slice(0, 300)}`);
    }
    return { openId: user.data.open_id, name: user.data.name ?? user.data.en_name ?? '' };
  }

  // -- OAuthServerProvider --------------------------------------------------

  async authorize(client, params, res) {
    await this.ready;
    if (!client.redirect_uris?.includes(params.redirectUri)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' });
      return;
    }

    const state = token();
    this.store.prune();
    // The Feishu `state` and the client's own `state` live in different hops, so
    // they are tracked separately; conflating them sends the client a state
    // value it never issued.
    this.store.data.pending[state] = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      clientState: params.state,
      expiresAt: now() + PENDING_TTL_MS,
    };
    await this.store.save();

    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.searchParams.set('client_id', this.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', `${this.publicUrl}/callback`);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'contact:user.base:readonly');

    this.log(`authorize: client ${client.client_id} -> Feishu`);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(_client, code) {
    await this.ready;
    return this.store.data.codes[code]?.codeChallenge ?? '';
  }

  async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri) {
    await this.ready;
    this.store.prune();
    const entry = this.store.data.codes[code];
    if (!entry) throw new Error('authorization code is unknown or already used');
    if (entry.expiresAt < now()) throw new Error('authorization code has expired');
    if (entry.clientId !== client.client_id) throw new Error('authorization code was issued to a different client');
    if (redirectUri && entry.redirectUri !== redirectUri) throw new Error('redirect_uri does not match the authorization request');

    if (entry.codeChallenge) {
      if (!codeVerifier) throw new Error('code_verifier is required');
      if (s256(codeVerifier) !== entry.codeChallenge) throw new Error('PKCE verification failed');
    }

    delete this.store.data.codes[code]; // single use
    return this.issueTokens(client.client_id, entry.scopes, entry.subject);
  }

  async exchangeRefreshToken(client, refreshToken, scopes) {
    await this.ready;
    this.store.prune();
    const entry = this.store.data.refresh[refreshToken];
    if (!entry) throw new Error('refresh token is unknown or expired');
    if (entry.clientId !== client.client_id) throw new Error('refresh token was issued to a different client');
    delete this.store.data.refresh[refreshToken];
    return this.issueTokens(client.client_id, scopes?.length ? scopes : entry.scopes, entry.subject);
  }

  async verifyAccessToken(accessToken) {
    await this.ready;
    const entry = this.store.data.access[accessToken];
    if (!entry) throw new Error('invalid access token');
    if (entry.expiresAt < now()) throw new Error('access token has expired');
    return { token: accessToken, clientId: entry.clientId, scopes: entry.scopes, expiresAt: Math.floor(entry.expiresAt / 1000), extra: { subject: entry.subject } };
  }

  async issueTokens(clientId, scopes, subject) {
    const access = token();
    const refresh = token();
    const expiresAt = now() + this.accessTtlSec * 1000;
    this.store.data.access[access] = { clientId, scopes, subject, expiresAt };
    this.store.data.refresh[refresh] = { clientId, scopes, subject, expiresAt: now() + DEFAULT_REFRESH_TTL_MS };
    await this.store.save();
    return { access_token: access, token_type: 'Bearer', expires_in: this.accessTtlSec, refresh_token: refresh, scope: scopes.join(' ') };
  }

  // -- /callback ------------------------------------------------------------

  async handleCallback(req, res) {
    await this.ready;
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      res.status(400).type('html').send(page('授权失败', String(errorDescription || error)));
      return;
    }

    this.store.prune();
    const pending = state ? this.store.data.pending[state] : null;
    if (!pending) {
      res.status(400).type('html').send(page('授权链接已失效', '这个登录链接已过期或已被使用，请回到客户端重新发起连接。'));
      return;
    }

    try {
      const identity = await this.feishuIdentity(String(code));
      if (this.allowedOpenIds.size && !this.allowedOpenIds.has(identity.openId)) {
        this.log(`callback: rejected open_id ${identity.openId} (${identity.name})`);
        res.status(403).type('html').send(page('无权访问', `飞书账号 ${identity.name || identity.openId} 不在允许名单内。`));
        return;
      }

      const authCode = token();
      this.store.data.codes[authCode] = {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scopes,
        subject: identity.openId,
        expiresAt: now() + CODE_TTL_MS,
      };
      delete this.store.data.pending[state];
      await this.store.save();

      const back = new URL(pending.redirectUri);
      back.searchParams.set('code', authCode);
      if (pending.clientState) back.searchParams.set('state', pending.clientState);
      this.log(`callback: authorized ${identity.name || identity.openId} for client ${pending.clientId}`);
      res.redirect(back.toString());
    } catch (err) {
      this.log(`callback failed: ${err.message}`);
      res.status(500).type('html').send(page('登录失败', err.message));
    }
  }
}

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6">
<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

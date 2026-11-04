#!/usr/bin/env node
import path from 'node:path';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadProjects } from './config.mjs';
import { createRepoRegistry } from './repos.mjs';
import { registerTools } from './tools.mjs';
import { FeishuOAuthProvider } from './oauth.mjs';

const env = process.env;
const log = (msg) => console.error(`[overleaf-mcp] ${new Date().toISOString()} ${msg}`);

const PORT = Number(env.PORT ?? 18800);
const HOST = env.HOST ?? '127.0.0.1';
const STATE_DIR = env.STATE_DIR ?? new URL('../state', import.meta.url).pathname;
const PUBLIC_URL = (env.PUBLIC_URL ?? '').replace(/\/$/, '');
const BASE_PATH = PUBLIC_URL ? new URL(PUBLIC_URL).pathname.replace(/\/$/, '') : '';
const RESOURCE_URL = PUBLIC_URL ? `${PUBLIC_URL}/mcp` : `http://${HOST}:${PORT}/mcp`;

// Where the protected-resource metadata lives. RFC 9728 puts it under the
// well-known root with the resource's path appended, which is also the only
// place a shared hostname can keep two MCP servers apart.
const PRM_PATH = `/.well-known/oauth-protected-resource${BASE_PATH}/mcp`;
const PRM_URL = PUBLIC_URL ? `${new URL(PUBLIC_URL).origin}${PRM_PATH}` : `http://${HOST}:${PORT}${PRM_PATH}`;

const fail = (msg) => {
  log(`FATAL: ${msg}`);
  process.exit(1);
};

const oauthConfigured = Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && PUBLIC_URL);
const noAuthAllowed = env.MCP_ALLOW_NO_AUTH === '1';

if (!oauthConfigured && !noAuthAllowed) {
  fail(
    'OAuth is not configured. Set PUBLIC_URL, FEISHU_APP_ID and FEISHU_APP_SECRET. ' +
      'For local experimentation only, set MCP_ALLOW_NO_AUTH=1 to run without authentication.',
  );
}
if (oauthConfigured && !PUBLIC_URL.startsWith('https://') && env.ALLOW_INSECURE_PUBLIC_URL !== '1') {
  fail('PUBLIC_URL must be an https:// URL — OAuth clients will not follow a plaintext redirect.');
}

const projects = await loadProjects(env);
const repoFor = createRepoRegistry({ projects, stateDir: STATE_DIR });
log(`loaded ${Object.keys(projects).length} project(s): ${Object.keys(projects).join(', ')}`);
log(`base path "${BASE_PATH || '/'}" → resource ${RESOURCE_URL}`);

function buildServer() {
  const server = new McpServer(
    { name: 'overleaf-mcp', version: '0.1.0' },
    {
      instructions:
        'Reads and edits Overleaf projects over the Overleaf Git bridge. Call get_sections before editing so you know the exact section titles.',
    },
  );
  registerTools(server, { projects, repoFor });
  return server;
}

const app = express();
app.disable('x-powered-by');
// One hop: we always sit behind the local nginx. `true` makes express-rate-limit
// warn that any client could forge X-Forwarded-For.
app.set('trust proxy', 1);

let provider = null;

if (oauthConfigured) {
  provider = new FeishuOAuthProvider({
    publicUrl: PUBLIC_URL,
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    allowedOpenIds: (env.ALLOWED_OPEN_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    stateDir: STATE_DIR,
    accessTtlSec: env.ACCESS_TOKEN_TTL_SEC ? Number(env.ACCESS_TOKEN_TTL_SEC) : undefined,
    log,
  });

  // The SDK's mcpAuthRouter builds every endpoint with `new URL('/authorize', …)`,
  // and a leading slash discards the base path. Mounting the handlers ourselves
  // is the only way to host under a sub-path.
  const metadata = {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/token`,
    registration_endpoint: `${PUBLIC_URL}/register`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: [],
  };

  app.use(`${BASE_PATH}/authorize`, authorizationHandler({ provider }));
  app.use(`${BASE_PATH}/token`, tokenHandler({ provider }));
  app.use(`${BASE_PATH}/register`, clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  app.get(`${BASE_PATH}/callback`, (req, res) => provider.handleCallback(req, res));

  // Clients differ on where they look for authorization-server metadata: RFC 8414
  // inserts the issuer path after the well-known segment, older implementations
  // append it, and some probe OpenID configuration instead. Serve every shape so
  // discovery cannot dead-end.
  const asMetadata = metadataHandler(metadata);
  // metadataHandler() returns an Express Router with a single `/` route, so it has
  // to be mounted with use(); app.get(path, router) silently never matches.
  for (const p of new Set([
    `/.well-known/oauth-authorization-server${BASE_PATH}`,
    `${BASE_PATH}/.well-known/oauth-authorization-server`,
    `/.well-known/openid-configuration${BASE_PATH}`,
    `${BASE_PATH}/.well-known/openid-configuration`,
  ])) {
    app.use(p, asMetadata);
  }

  const prm = (_req, res) =>
    res.json({
      resource: RESOURCE_URL,
      authorization_servers: [PUBLIC_URL],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
      resource_name: 'Overleaf',
    });
  for (const p of new Set([
    PRM_PATH,
    `/.well-known/oauth-protected-resource${BASE_PATH}`,
    `${BASE_PATH}/.well-known/oauth-protected-resource`,
  ])) {
    app.get(p, prm);
  }
}

const unauthorized = (res) =>
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${PRM_URL}"`)
    .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });

const requireBearer = async (req, res, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return unauthorized(res);
  try {
    req.auth = await provider.verifyAccessToken(match[1].trim());
    next();
  } catch {
    unauthorized(res);
  }
};

// ---------------------------------------------------------------------------
// Raw file transfer, for assets too large to pass through a tool argument.
//
//   curl -H "Authorization: Bearer $FILE_TOKEN" https://host/files/default/figures/a.png -o a.png
//   curl -H "Authorization: Bearer $FILE_TOKEN" -T figures/a.png https://host/files/default/figures/a.png
//
// Guarded by a standalone token rather than the OAuth flow: the OAuth token lives
// in the client, and nobody wants to extract it into a shell to push a figure.
// ---------------------------------------------------------------------------
const FILE_TOKEN = env.FILE_TOKEN ?? '';
const READ_ONLY = env.READ_ONLY === '1';
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8', '.sty': 'text/plain; charset=utf-8', '.cls': 'text/plain; charset=utf-8',
};

const requireFileToken = (req, res, next) => {
  if (!FILE_TOKEN) return res.status(404).json({ error: 'file endpoint disabled; set FILE_TOKEN to enable it' });
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const given = Buffer.from(match?.[1]?.trim() ?? '');
  const want = Buffer.from(FILE_TOKEN);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};

const fileProject = (req) => req.params.project;
const filePath = (req) => decodeURIComponent(req.params[0] ?? '');

app.get('/files/:project/*', requireFileToken, async (req, res) => {
  try {
    const repo = repoFor(fileProject(req));
    const { rel, buffer } = await repo.run(async () => {
      await repo.fetchAndReset();
      return repo.readBinary(filePath(req));
    });
    res.type(MIME_BY_EXT[path.extname(rel).toLowerCase()] ?? 'application/octet-stream').send(buffer);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.put('/files/:project/*', requireFileToken, express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  if (READ_ONLY) return res.status(403).json({ error: 'server is read-only' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty body' });
  try {
    const repo = repoFor(fileProject(req));
    const message = String(req.headers['x-commit-message'] ?? '').trim() || `Upload ${filePath(req)}`;
    const result = await repo.run(async () => {
      await repo.fetchAndReset();
      return repo.writeBinary(filePath(req), req.body, message);
    });
    res.json({ ok: true, path: filePath(req), bytes: req.body.length, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get(`${BASE_PATH}/healthz`, (_req, res) =>
  res.json({ ok: true, projects: new Set(Object.values(projects).map((p) => p.projectId)).size, auth: oauthConfigured ? 'feishu-oauth' : 'none', basePath: BASE_PATH || '/' }),
);

app.use(`${BASE_PATH}/mcp`, express.json({ limit: '8mb' }), provider ? requireBearer : (_req, _res, next) => next());

const handleMcp = async (req, res) => {
  // Stateless: one server + transport per request. No session id means clients
  // reconnect cleanly after a restart instead of holding a dead session id.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log(`mcp request failed: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
  }
};

app.post(`${BASE_PATH}/mcp`, handleMcp);
app.get(`${BASE_PATH}/mcp`, handleMcp);
app.delete(`${BASE_PATH}/mcp`, handleMcp);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const httpServer = app.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}${BASE_PATH}/mcp`);
  log(`auth ${oauthConfigured ? `Feishu OAuth via ${PUBLIC_URL}` : 'DISABLED (MCP_ALLOW_NO_AUTH=1)'}`);
});

const shutdown = (signal) => {
  log(`${signal} received, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

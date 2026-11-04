# overleaf-mcp

A remote [MCP](https://modelcontextprotocol.io) server for Overleaf. It reads, parses and edits a LaTeX project through Overleaf's Git bridge, and speaks Streamable HTTP with OAuth 2.1 so hosted clients — ChatGPT custom connectors, Claude, anything that speaks remote MCP — can use it.

Derived from [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP) (MIT). The tool surface is the same idea; the transport, auth, git handling and LaTeX parser are rewritten.

## What it does differently

| | upstream | here |
|---|---|---|
| Transport | stdio only | Streamable HTTP, so remote clients can connect |
| Auth | none (local process) | OAuth 2.1 + DCR + PKCE, delegating identity to an IdP |
| Git token | embedded in the clone URL (`https://git:TOKEN@…`) | 0600 credential file via `credential.helper`, never in argv, env or `.git/config` |
| Pull | `git pull` per call, conflicts surface as errors | fetch + `reset --hard`, refusing when unpushed commits exist |
| Section extents | next heading of *any* level | next heading of the *same or higher* level |
| Commented-out `% \section{}` | parsed as a real section | masked out before parsing |
| Tests | none | 16 |

## Requirements

- Node.js 20+
- An Overleaf plan with **Git integration** (the free tier does not have it) and a git token from *Account Settings → Git Integration*
- For remote use: a public HTTPS host, plus an OAuth identity provider

## Configuration

All configuration is environment variables.

| Variable | Required | Meaning |
|---|---|---|
| `OVERLEAF_PROJECTS_CONFIG` | one of these two | Path to a `projects.json` |
| `OVERLEAF_PROJECT_ID` | | Single-project shortcut |
| `OVERLEAF_GIT_TOKEN_FILE` | recommended | Path to a 0600 file holding the token |
| `OVERLEAF_GIT_TOKEN` | | Token inline (avoid: it lands in the process environment) |
| `OVERLEAF_GIT_BASE` | | Git host, default `https://git.overleaf.com` (Server Pro users override this) |
| `PUBLIC_URL` | remote | Public origin, e.g. `https://overleaf.example.com` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | remote | Identity provider app |
| `ALLOWED_OPEN_ID` | remote | Comma-separated allow-list of identities. **Empty means anyone who can reach the app may authorize** |
| `STATE_DIR` | | Clones, credentials and OAuth state |
| `PORT` / `HOST` | | Default `18800` / `127.0.0.1` |
| `ACCESS_TOKEN_TTL_SEC` | | Default 24h |
| `MCP_ALLOW_NO_AUTH` | | `1` disables auth. Local development only |

### `projects.json`

```json
{
  "projects": {
    "default": {
      "name": "My paper",
      "projectId": "64a1b2c3d4e5f6a7b8c9d0e1",
      "gitTokenFile": "/etc/overleaf-mcp/token"
    },
    "thesis": {
      "name": "PhD thesis",
      "projectId": "0123456789abcdef01234567",
      "gitTokenFile": "/etc/overleaf-mcp/token"
    }
  }
}
```

The project id is the last path segment of `https://www.overleaf.com/project/<id>`. Overleaf git tokens are account-wide, so one token normally serves every project.

## Tools

| Tool | Purpose |
|---|---|
| `list_projects` | Which projects are configured |
| `list_files` | File inventory, filtered by extension |
| `read_file` | Verbatim file contents |
| `get_sections` | Section outline with level, line and character range |
| `get_section_content` | One section, including everything it owns |
| `status_summary` | File inventory plus the outline of the root document |
| `write_file` | Replace a whole file and push one commit |
| `write_section` | Replace one section and push one commit |

`write_section` is the one to reach for: a whole-file write silently discards anything the model failed to reproduce, while a section write is bounded by the parser.

## Running

```bash
npm install
node --env-file=.env src/server.mjs
```

For local development without OAuth:

```bash
MCP_ALLOW_NO_AUTH=1 OVERLEAF_PROJECT_ID=… OVERLEAF_GIT_TOKEN_FILE=… node src/server.mjs
```

## Authentication

The server is its own OAuth 2.1 authorization server. Feishu answers exactly one question — *who is this* — and nothing else:

1. `POST /mcp` without a token returns `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
2. The client reads the protected-resource metadata, then the authorization-server metadata, then registers itself via DCR at `/register`.
3. `/authorize` validates the `redirect_uri` against the registration and redirects to Feishu's login.
4. Feishu returns to `/callback`; the server exchanges the code, checks the identity against `ALLOWED_OPEN_ID`, mints its own authorization code and redirects to the client.
5. `/token` verifies PKCE (S256) and issues local access and refresh tokens.

Tokens, clients and pending authorizations live in `$STATE_DIR/oauth.json` (0600) and survive restarts.

The Feishu app must have `https://<PUBLIC_URL host>/callback` in its redirect-URL allow-list.

## Deployment

`deploy/` contains a systemd unit and an nginx vhost. Notes that cost time to learn:

- The service must run as a dedicated user; `STATE_DIR` ends up holding clones and OAuth state.
- Keep `proxy_buffering off` for `/mcp` — MCP responses are server-sent events and buffering makes them hang.
- Git needs a writable `HOME`; the unit sets it to `STATE_DIR`.
- Set `READ_WRITE=no` in the nginx vhost for read-only deployments.

## Licence

MIT. Upstream: [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP).

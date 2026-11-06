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
| `get_tree` | File tree with sizes; binaries collapsed unless asked for |
| `read_file` | Line-numbered read with `offset`/`limit` paging |
| `grep` | Regex search returning `file:line` |
| `apply_edits` | Atomic edit — exact-text or line-range, all-or-nothing |
| `write_file` | Whole-file replace or create |
| `read_image` | Return a figure as a picture |
| `upload_file` | Add a binary asset from base64 |
| `status_summary` | Inventory plus the outline of the whole document tree |

### Why there is no `write_section`

An earlier version had `get_sections` / `get_section_content` / `write_section`.
They were removed, because the abstraction is unsound:

- Section titles are not unique — `Experiments` appears in both the paper and the rebuttal.
- A section's extent is ambiguous as soon as it has subsections, and rewriting one silently deleted them.
- `write_section` required `newContent` to repeat the heading, one more convention to get wrong.

`apply_edits` replaces all three with the mechanical primitives every coding agent
converged on: read with line numbers, then replace exact bytes. It refuses an
ambiguous match rather than picking one, and if any edit in a call fails, nothing
is written — a half-applied commit is worse than a retry.

The LaTeX parser still exists, but only to build the outline in `status_summary`;
no write path depends on it.

### Concurrent edits

Overleaf is edited in the browser while the server holds a clone, so a push can
lose the race. When it does, the local commit is replayed on top of the other
one and the push is retried once — the edit is not lost, and the model does not
have to redo it against a tree that already contains it. If the two histories
genuinely disagree, the rebase is aborted so the clone is never left
half-resolved, and the error names the command to run on the host.

## File transfer

Two ways to move assets, because they suit different sizes.

**Through a tool** — `read_image` returns a figure as an MCP image block so the model can actually see it; `upload_file` takes base64 and is capped at 3 MB, since tool arguments are not a bulk transport.

**Over HTTP** — for real transfers set `FILE_TOKEN` and use `/files`:

```bash
# download
curl -H "Authorization: Bearer $FILE_TOKEN" \
     https://host/files/default/figures/pipeline/latent.jpg -o latent.jpg

# upload (path is created, change is committed and pushed)
curl -H "Authorization: Bearer $FILE_TOKEN" -H "X-Commit-Message: Update pipeline figure" \
     -T figures/latent.jpg https://host/files/default/figures/pipeline/latent.jpg
```

`/files` uses its own bearer token rather than the OAuth flow: the OAuth token lives inside the client, and nobody wants to dig it out to push one figure. Set `READ_ONLY=1` to refuse uploads while keeping downloads.

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

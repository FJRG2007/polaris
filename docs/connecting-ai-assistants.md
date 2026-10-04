# Connecting AI assistants (MCP)

Polaris is an MCP server. Claude, ChatGPT, Cursor, VS Code and any other client
that speaks remote MCP over HTTP can connect to it, sign in as you, and work with
your tasks, deployments, notes, chat, Drive and calendar. Each assistant can do
only what you approve when it connects, and never more than your own account.

The quickest way in is **Account > Downloads > AI assistants (MCP)**, which shows
your server URL and the setup for each client with copy buttons and install
links. This page is the same information, plus how it works.

## Your server URL

```
https://<your-polaris-address>/api/mcp
```

Use the address you open Polaris on. A connection made on one address (your
domain) does not work on another (`polaris.local`); connect again there if you
use both.

## Setting up each client

Every client below signs in through Polaris's own consent screen. No key is
copied anywhere.

### Claude Code

```sh
claude mcp add --transport http polaris https://<your-polaris-address>/api/mcp
```

Then run `/mcp` inside Claude Code and choose `polaris` to sign in. Add
`--scope user` to have it in every project, or `--scope project` to share it
through `.mcp.json`.

### Claude (claude.ai and Claude Desktop)

1. Open **Customize > Connectors** and choose **Add custom connector**.
2. Name it Polaris, paste the server URL, and choose **Add**.
3. Choose **Connect** and sign in to Polaris.

On Team and Enterprise plans an owner adds the connector first, under
**Organization settings > Connectors**. Claude connects from Anthropic's
servers, so your Polaris must be reachable from the internet for this one.

### ChatGPT

Needs a Plus, Pro, Business, Enterprise or Education plan, on the web.

1. Open **Settings > Security and login** and turn on **Developer mode**.
2. In **Plugins**, select **+** and create an app with the server URL. Choose
   OAuth.
3. Sign in to Polaris when ChatGPT asks.

Like Claude on the web, ChatGPT connects from its own servers and needs Polaris
reachable from the internet.

### Cursor

Use **Add to Cursor** on the Downloads page, or add this to `~/.cursor/mcp.json`:

```json
{
    "mcpServers": {
        "polaris": { "url": "https://<your-polaris-address>/api/mcp" }
    }
}
```

Cursor asks you to sign in the first time it uses Polaris.

### Visual Studio Code

Use **Add to VS Code** on the Downloads page, run
`code --add-mcp '{"name":"polaris","type":"http","url":"https://<your-polaris-address>/api/mcp"}'`,
or add this to `.vscode/mcp.json`:

```json
{
    "servers": {
        "polaris": { "type": "http", "url": "https://<your-polaris-address>/api/mcp" }
    }
}
```

### Codex CLI and others

```sh
codex mcp add polaris --url https://<your-polaris-address>/api/mcp
codex mcp login polaris
```

Any other client that supports remote MCP servers with OAuth connects with the
server URL alone.

### With an API key instead

A client that cannot sign in (a script, a CI job) can send a Polaris API key
from **Account > API keys** as `Authorization: Bearer plk_...`. For Claude Code:

```sh
claude mcp add --transport http polaris https://<your-polaris-address>/api/mcp \
    --header "Authorization: Bearer plk_..."
```

The key's scopes work exactly like an assistant's.

## What you approve

When an assistant connects you see its name, **the address it sends you back
to**, and a box per permission. The name is what the app says about itself; the
return address is the part Polaris checks, so look at that. An app that returns
to `localhost` or `127.0.0.1` runs on your own computer: only continue if you
started the connection yourself.

Untick anything it should not do. Ticking a permission that needs another (for
example, changing tasks needs reading them) ticks that one too.

| Permission       | What the assistant can do                                        |
| ---------------- | ---------------------------------------------------------------- |
| `tasks.read`     | Read spaces, lists and tasks                                     |
| `tasks.manage`   | Create tasks, change them, and comment                           |
| `agents.read`    | See agent sessions                                               |
| `agents.manage`  | Start agent sessions and send them prompts                       |
| `deploy.read`    | See apps, deployments, logs, variables (never secret values) and domains |
| `deploy.manage`  | Deploy, restart, roll back, set variables and add domains        |
| `notes.use`      | List, read, write and change your notes                          |
| `chat.use`       | List your conversations, read them and send messages             |
| `drive.read`     | List your storages and folders, and see a file's details         |
| `shares.create`  | Create a public share link to a file you can download            |
| `calendar.use`   | See what is coming up on your calendars                          |

Only the permissions your account holds are offered.

## Managing connected assistants

**Account > API keys > Connected assistants** lists every assistant you have
connected, what it may do, and when it was last used. **Disconnect** stops it at
once: every token it holds is ended, and it has to be connected again through
the consent screen.

Connecting an assistant raises the same security alert as creating an API key,
and so does a connection Polaris ends on its own because one of its tokens was
presented twice - which means somebody else held it. Both open **Account > API
keys**.

If you go through the consent screen again for an app you already connected and
untick a permission, every token it holds - including ones already issued - is
cut down to what you ticked the next time it is used or refreshed, not only on
its next new token.

If you are removed from a role, your assistants lose what that role gave them on
their next call.

## Tools

Read tools first, then the ones that change something. Clients use the
annotations to ask you before a change; tools marked "changes" ask by default.

| Tool                   | Permission      | Kind                         |
| ---------------------- | --------------- | ---------------------------- |
| `polaris_whoami`       | none            | read                         |
| `tasks_list`, `tasks_get`, `tasks_spaces` | `tasks.read` | read        |
| `tasks_create`, `tasks_comment` | `tasks.manage` | adds                  |
| `tasks_update`         | `tasks.manage`  | changes                      |
| `agent_sessions_list`, `agent_session_get` | `agents.read` | read      |
| `agent_session_start`, `agent_session_prompt` | `agents.manage` | adds |
| `deploy_projects`, `deploy_service`, `deploy_deployments`, `deploy_deployment`, `deploy_logs`, `deploy_variables`, `deploy_domains` | `deploy.read` | read |
| `deploy_add_domain`    | `deploy.manage` | adds                         |
| `deploy_start`, `deploy_set_variable`, `deploy_restart`, `deploy_rollback` | `deploy.manage` | changes |
| `notes_list`, `notes_get` | `notes.use`  | read                         |
| `notes_create`         | `notes.use`     | adds                         |
| `notes_update`         | `notes.use`     | changes                      |
| `chat_conversations`, `chat_messages` | `chat.use` | read              |
| `chat_send`            | `chat.use`      | adds                         |
| `drive_sources`, `drive_list`, `drive_stat` | `drive.read` | read      |
| `drive_share_create`   | `shares.create` | changes (publishes a file)   |
| `calendar_upcoming`    | `calendar.use`  | read                         |

Not offered on purpose: secret values, file contents, vault items and mail.
Every change made through a tool is written to your activity log with the
assistant that made it. Each connection may make 120 tool calls a minute, 30 of
them changes.

## How it works

Polaris follows the MCP authorization spec
([modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)):
OAuth 2.1 with Polaris as its own authorization server.

| Endpoint                                             | What it is                                      |
| ---------------------------------------------------- | ----------------------------------------------- |
| `POST /api/mcp`                                      | The MCP server (Streamable HTTP, JSON answers)  |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | Protected Resource Metadata (RFC 9728)         |
| `GET /.well-known/oauth-authorization-server`        | Authorization Server Metadata (RFC 8414)        |
| `POST /api/oauth/register`                           | Dynamic Client Registration (RFC 7591)          |
| `GET /oauth/authorize`                               | The consent screen                              |
| `POST /api/oauth/token`                              | Token endpoint: authorization code and refresh  |
| `POST /api/oauth/revoke`                             | Token revocation (RFC 7009)                     |

- A call with no credential is answered `401` with a `WWW-Authenticate`
  challenge pointing at the resource metadata, which is how a client finds the
  rest.
- Apps register themselves (RFC 7591) or are named by the https address of
  their Client ID Metadata Document, which Polaris fetches. Redirect addresses
  must be https, or http to `localhost`, `127.0.0.1` or `[::1]`; they are matched
  exactly, except that a loopback address may use any port (RFC 8252).
- PKCE with S256 is required. Codes last five minutes and work once. Answers
  carry `iss` (RFC 9207).
- Access tokens last an hour and work only on `/api/mcp` at the address they
  were issued for (RFC 8707 resource indicators). Refresh tokens last 30 days
  and change on every use; presenting an old one ends the whole connection, as
  does exchanging a code twice.
- Polaris stores only SHA-256 hashes of codes, tokens and client secrets.
- The consent page cannot be shown inside a frame.

## Troubleshooting

- **The client says it cannot reach the server.** Claude on the web and ChatGPT
  connect from their own servers, so Polaris has to be reachable from the
  internet on the address you gave them. Claude Code, Cursor and VS Code only
  need to reach it from your computer.
- **"This connection cannot continue".** The link did not come from an app
  Polaris can identify, or would send you to an address the app never
  registered. Start the connection again from the app.
- **A tool says the connection needs a scope.** Connect the app again and tick
  that permission, or ask an administrator for it if it is not offered.
- **It stopped working.** Check Connected assistants: if it is not listed, it
  was disconnected (by you, or because one of its tokens was used twice).
  Connect it again from the app.

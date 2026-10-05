# Connecting AI assistants (MCP)

Polaris is an MCP server. Claude, ChatGPT, Cursor, VS Code and any other client
that speaks remote MCP (Streamable HTTP or SSE, or stdio through mcp-remote) can
connect to it, sign in as you, and work with your tasks, deployments, notes, chat,
Drive and mail - and, when they are installed, your calendar, your places'
devices and your game servers. Each assistant can do only what you approve when
it connects, and never more than your own account.

The quickest way in is **Account > AI assistants**, which shows your server URL
and the setup for each client with copy buttons and install links. This page is
the same information, plus how it works.

## Your server URL

```
https://<your-polaris-address>/api/mcp
```

Use the address you open Polaris on. A connection made on one address (your
domain) does not work on another (`polaris.local`); connect again there if you
use both.

A client that only speaks the older HTTP+SSE transport uses
`https://<your-polaris-address>/api/mcp/sse` instead. It takes the same sign-in
and the same permissions.

## Setting up each client

Every client below signs in through Polaris's own consent screen. No key is
copied anywhere. **Account > AI assistants** has the same guides with your
address filled in: pick your client from the grid.

### Claude (claude.ai and Claude Desktop)

1. Open **Customize > Connectors** and choose **Add custom connector**.
2. Name it Polaris, paste the server URL, and choose **Add**.
3. Choose **Connect** and sign in to Polaris.

On Team and Enterprise plans an owner adds the connector first, under
**Organization settings > Connectors**. Claude connects from Anthropic's
servers, so your Polaris must be reachable from the internet for this one.
[Claude's guide](https://claude.com/docs/connectors/custom/remote-mcp)

### Claude Code

```sh
claude mcp add --transport http polaris https://<your-polaris-address>/api/mcp
```

Then run `/mcp` inside Claude Code and choose `polaris` to sign in. Add
`--scope user` to have it in every project, or `--scope project` to share it
through `.mcp.json`. [Claude Code's guide](https://code.claude.com/docs/en/mcp)

### ChatGPT

Needs a Plus, Pro, Business, Enterprise or Education plan, on the web. In a
Business, Enterprise or Education workspace, an admin may have to allow
Developer mode first.

1. Open **Settings > Security and login** and turn on **Developer mode**.
2. Open **Plugins**, select **Add**, then **Create MCP App**.
3. Name it Polaris. Under **Connection**, keep **Server URL** and paste the
   server URL.
4. Set **Authentication** to **OAuth**. No client ID or secret is needed:
   Polaris registers ChatGPT itself.
5. Check **I understand and want to continue**, then select **Create**.
6. Sign in to Polaris when ChatGPT asks.

If **Add** only offers **Create plugin** and **Upload plugin**, Developer mode
is off. Those two are for packaged plugins and do not take a server URL.

Like Claude on the web, ChatGPT connects from its own servers and needs Polaris
reachable from the internet.
[OpenAI's guide](https://developers.openai.com/api/docs/guides/developer-mode)

### Cursor

Use **Add to Cursor** on the AI assistants page (Cursor's documented
`cursor://anysphere.cursor-deeplink/mcp/install` link), or add this to
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "polaris": { "url": "https://<your-polaris-address>/api/mcp" }
  }
}
```

Cursor asks you to sign in the first time it uses Polaris.
[Cursor's guide](https://cursor.com/docs/context/mcp)

### Visual Studio Code

Use **Add to VS Code** on the AI assistants page, run
`code --add-mcp '{"name":"polaris","type":"http","url":"https://<your-polaris-address>/api/mcp"}'`,
or run **MCP: Open User Configuration** and add:

```json
{
  "servers": {
    "polaris": {
      "type": "http",
      "url": "https://<your-polaris-address>/api/mcp"
    }
  }
}
```

[VS Code's guide](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)

### GitHub Copilot

Copilot in VS Code uses the Visual Studio Code setup above. For Copilot CLI:

```sh
copilot mcp add --transport http polaris https://<your-polaris-address>/api/mcp
```

and sign in when Copilot asks. The Copilot cloud agent cannot sign in to
servers, so it needs an API key instead (see below).
[GitHub's guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)

### Codex CLI

```sh
codex mcp add polaris --url https://<your-polaris-address>/api/mcp
codex mcp login polaris
```

### Devin

1. Open **Customize > MCPs**, choose **Add MCP**, then **Add custom MCP**.
2. Name it Polaris, choose the **HTTP** transport, paste the server URL, and
   **Save**.
3. Choose **Connect** and sign in to Polaris.

[Devin's guide](https://docs.devin.ai/work-with-devin/mcp)

### Figma Make

1. In a Figma Make chat, click **Add context**, hover over **Connectors** and
   select **Manage**.
2. On **Created by you**, click **Create**, name it Polaris and paste the server
   URL.
3. Click **Create**, then **Connect**, and sign in to Polaris.

Needs a paid Figma plan; an admin can turn custom connectors off.
[Figma's guide](https://help.figma.com/hc/en-us/articles/38147204302743-Create-and-use-custom-MCP-connectors-in-Figma-Make)

### Grok

1. Open [grok.com/connectors](https://grok.com/connectors).
2. Click **New Connector**, then select **Custom**.
3. Paste the server URL and sign in to Polaris when Grok asks.

On Grok Business and Enterprise, an admin adds the connector first.
[xAI's guide](https://docs.x.ai/grok/connectors)

### Mistral Le Chat

1. Open **Connectors**, click **+ Add Connector** and switch to **Custom MCP
   Connector**.
2. Name it `polaris` and paste the server URL.
3. Click **Connect** and sign in to Polaris.

Only an administrator can add a custom connector.
[Mistral's guide](https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors)

### Zapier

1. Open **Apps**, click **+ Add connection** and choose **MCP Client**.
2. Paste the server URL, set **Transport** to **Streamable HTTP** and **OAuth**
   to **Yes**.
3. Click **Yes, Continue to MCP Client** and sign in to Polaris.

[Zapier's guide](https://help.zapier.com/hc/en-us/articles/38777069364109-Connect-remote-MCP-servers-to-Zapier-using-MCP-Client)

### Make

1. Add an **MCP Client** module to a scenario and click **Create a connection**.
2. Under **MCP Server**, choose **+ New MCP Server** and paste the server URL.
3. Click **Save**, and sign in to Polaris if Make asks.

[Make's guide](https://apps.make.com/mcp-client)

### OpenCode

Add this to `opencode.json`:

```json
{
  "mcp": {
    "polaris": {
      "type": "remote",
      "url": "https://<your-polaris-address>/api/mcp",
      "enabled": true
    }
  }
}
```

Then sign in with `opencode mcp auth polaris`.
[OpenCode's guide](https://opencode.ai/docs/mcp-servers/)

### Kimi Code

```sh
kimi mcp add --transport http --auth oauth polaris https://<your-polaris-address>/api/mcp
kimi mcp auth polaris
```

[Kimi Code's guide](https://moonshotai.github.io/kimi-cli/en/customization/mcp.html)

### Any other client

1. Open your client's MCP or connector settings.
2. Choose a connection type.
3. Copy the configuration for it.
4. Sign in to Polaris when your client asks.

Streamable HTTP, for clients that support remote servers (recommended):

```json
{
  "mcpServers": {
    "polaris": { "url": "https://<your-polaris-address>/api/mcp" }
  }
}
```

SSE, for clients that support remote servers but not Streamable HTTP:

```json
{
  "mcpServers": {
    "polaris": {
      "type": "sse",
      "url": "https://<your-polaris-address>/api/mcp/sse"
    }
  }
}
```

stdio, for clients that only run local commands. It needs Node.js;
[mcp-remote](https://www.npmjs.com/package/mcp-remote) bridges to Polaris and
opens the sign-in in your browser:

```json
{
  "mcpServers": {
    "polaris": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-polaris-address>/api/mcp"]
    }
  }
}
```

### With an API key instead

A client that cannot sign in (a script, a CI job, the Copilot cloud agent) can
send a Polaris API key from **Account > API keys** as
`Authorization: Bearer plk_...`. For Claude Code:

```sh
claude mcp add --transport http polaris https://<your-polaris-address>/api/mcp \
    --header "Authorization: Bearer plk_..."
```

The key's scopes work exactly like an assistant's. A key holds permissions
only, so the finer scopes below (mail, calendar, Places, game servers) are for
assistants that sign in.

## What you approve

When an assistant connects you see its name, **the address it sends you back
to**, and a box per permission. The name is what the app says about itself; the
return address is the part Polaris checks, so look at that. An app that returns
to `localhost` or `127.0.0.1` runs on your own computer: only continue if you
started the connection yourself.

Untick anything it should not do. Ticking a permission that needs another (for
example, changing tasks needs reading them) ticks that one too. What reaches
outside Polaris or into your home - sending mail, changing your calendar,
operating a device, running a routine, starting or stopping a game server -
starts unticked: tick it only if you mean the assistant to do it.

| Permission      | What the assistant can do                                              |
| --------------- | ---------------------------------------------------------------------- |
| `tasks.read`    | Read spaces, lists and tasks                                           |
| `tasks.manage`  | Create tasks, change them, and comment                                 |
| `agents.read`   | See agent sessions                                                     |
| `agents.manage` | Start agent sessions and send them prompts                             |
| `deploy.read`   | See apps, deployments, logs, variable names (never values) and domains |
| `deploy.manage` | Deploy, restart, roll back, set variables and add domains              |
| `notes.use`     | List, read, write and change your notes                                |
| `chat.use`      | List your conversations, read them and send messages                   |
| `drive.read`    | List your storages and folders, and see a file's details               |
| `shares.create` | Create a public share link to a file you can download                  |
| `mail.read`     | List, search and read the mail in mailboxes you linked                 |
| `mail.send`     | Send mail from your mailboxes, in your name                            |

With the Calendar, Places or Game servers app installed:

| Permission           | What the assistant can do                                     |
| -------------------- | ------------------------------------------------------------- |
| `calendar.read`      | See your calendars and their events                           |
| `calendar.manage`    | Create, change and delete events (includes `calendar.read`)   |
| `places.read`        | See the devices in your places and their state                |
| `places.control`     | Lock, unlock, switch and set devices (includes `places.read`) |
| `places.routines`    | See and run your places' routines                             |
| `gameservers.read`   | See your game servers and who is playing                      |
| `gameservers.manage` | Start, stop and restart them, and use their consoles          |

Each of these stands on a permission of your account - mail on using Mail,
calendar on using the Calendar, devices on seeing or controlling places,
routines on managing them, game servers on seeing or managing them - and does
nothing once you no longer hold it. Only the permissions your account holds,
and of the apps installed here, are offered.

An assistant connected before reading and changing the calendar were split may
hold `calendar.use`: it keeps reading your upcoming events, and can be given
`calendar.read` or `calendar.manage` from **Change permissions**.

## Managing connected assistants

**Account > AI assistants** lists every assistant you have connected, what it
may do, and when and from where it was last used.

- **Change permissions** opens the same boxes as the consent screen. A
  permission you take away is refused on the assistant's next call; one you add
  works on its next call too. Anything Polaris offers can be added - a
  permission the assistant did not ask for when it connected, or one added to
  Polaris since, is marked as such and stays off until you tick it - but never
  more than your own account holds. A permission of an app that is no longer
  installed is not shown and is kept as it was.
- **Where it may connect from** sets an address rule for that one connection,
  on top of your account's access rules: anywhere (the default), only the
  address you approved it from, an allow and deny list of IP addresses and
  ranges (IPv4 and IPv6; a deny entry wins), or only from where you are signed
  in to Polaris right now (an IPv6 address counts for its whole /64). It is
  checked on every call and every token refresh. A refused call gets a 403
  saying the address is not allowed, and the refusal shows on the connection
  and in your activity.
- **Disconnect** stops it at once: every token it holds is ended, and it has to
  be connected again through the consent screen.

Connecting an assistant raises the same security alert as creating an API key,
and so do changing what one may do and a connection Polaris ends on its own
because one of its tokens was presented twice - which means somebody else held
it. All of them open **Account > AI assistants**.

If you go through the consent screen again for an app you already connected and
untick a permission, every token it holds - including ones already issued - is
cut down to what you ticked the next time it is used or refreshed, not only on
its next new token.

If you are removed from a role, your assistants lose what that role gave them on
their next call.

## Tools

Read tools first, then the ones that change something. Clients use the
annotations to ask you before a change; tools marked "changes" ask by default.

| Tool                                                                                                                                            | Permission                 | Kind                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------- |
| `polaris_whoami`                                                                                                                                | none                       | read                         |
| `tasks_list`, `tasks_get`, `tasks_spaces`                                                                                                       | `tasks.read`               | read                         |
| `tasks_create`, `tasks_comment`                                                                                                                 | `tasks.manage`             | adds                         |
| `tasks_update`                                                                                                                                  | `tasks.manage`             | changes                      |
| `agent_sessions_list`, `agent_session_get`                                                                                                      | `agents.read`              | read                         |
| `agent_session_start`, `agent_session_prompt`                                                                                                   | `agents.manage`            | adds                         |
| `deploy_projects`, `deploy_service`, `deploy_deployments`, `deploy_deployment`, `deploy_logs`, `deploy_variables`, `env_list`, `deploy_domains` | `deploy.read`              | read                         |
| `deploy_add_domain`                                                                                                                             | `deploy.manage`            | adds                         |
| `deploy_start`, `deploy_set_variable`, `env_set`, `env_delete`, `deploy_restart`, `deploy_rollback`                                             | `deploy.manage`            | changes                      |
| `notes_list`, `notes_get`                                                                                                                       | `notes.use`                | read                         |
| `notes_create`                                                                                                                                  | `notes.use`                | adds                         |
| `notes_update`                                                                                                                                  | `notes.use`                | changes                      |
| `chat_conversations`, `chat_messages`                                                                                                           | `chat.use`                 | read                         |
| `chat_send`                                                                                                                                     | `chat.use`                 | adds                         |
| `drive_sources`, `drive_list`, `drive_stat`                                                                                                     | `drive.read`               | read                         |
| `drive_share_create`                                                                                                                            | `shares.create`            | changes (publishes a file)   |
| `mail_mailboxes`                                                                                                                                | `mail.read` or `mail.send` | read                         |
| `mail_list`, `mail_read`                                                                                                                        | `mail.read`                | read                         |
| `mail_send`                                                                                                                                     | `mail.send`                | adds (after your undo delay) |

Offered only while their app is installed:

| Tool                                    | Permission                        | Kind                   |
| --------------------------------------- | --------------------------------- | ---------------------- |
| `calendar_upcoming`                     | `calendar.read` or `calendar.use` | read                   |
| `calendar_calendars`, `calendar_events` | `calendar.read`                   | read                   |
| `calendar_create`                       | `calendar.manage`                 | adds                   |
| `calendar_update`                       | `calendar.manage`                 | changes                |
| `calendar_delete`                       | `calendar.manage`                 | changes (to the trash) |
| `places_devices`                        | `places.read`                     | read                   |
| `places_device_control`                 | `places.control`                  | changes                |
| `places_routines`                       | `places.routines`                 | read                   |
| `places_routine_run`                    | `places.routines`                 | adds (a run)           |
| `games_servers`, `games_server_status`  | `gameservers.read`                | read                   |
| `games_server_power`, `games_console`   | `gameservers.manage`              | changes                |

Each tool applies the same rules as the app's own screens: a calendar shared
with you read-only stays read-only, a device somebody lent you is the only one
you can open, the console needs the console grant on that server.

Not offered on purpose: variable values, file contents, vault items, mail
attachments, cameras and footage.
A value set with `env_set` is stored and never returned.
Every change made through a tool is written to your activity log with the
assistant that made it. Each connection may make 120 tool calls a minute, 30 of
them changes.

## How it works

Polaris follows the MCP authorization spec
([modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)):
OAuth 2.1 with Polaris as its own authorization server.

| Endpoint                                              | What it is                                         |
| ----------------------------------------------------- | -------------------------------------------------- |
| `POST /api/mcp`                                       | The MCP server (Streamable HTTP, JSON answers)     |
| `GET`/`POST /api/mcp/sse`                             | The same server over the legacy HTTP+SSE transport |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | Protected Resource Metadata (RFC 9728)             |
| `GET /.well-known/oauth-authorization-server`         | Authorization Server Metadata (RFC 8414)           |
| `POST /api/oauth/register`                            | Dynamic Client Registration (RFC 7591)             |
| `GET /oauth/authorize`                                | The consent screen                                 |
| `POST /api/oauth/token`                               | Token endpoint: authorization code and refresh     |
| `POST /api/oauth/revoke`                              | Token revocation (RFC 7009)                        |

- A call with no credential is answered `401` with a `WWW-Authenticate`
  challenge pointing at the resource metadata, which is how a client finds the
  rest.
- Apps register themselves (RFC 7591) or are named by the https address of
  their Client ID Metadata Document, which Polaris fetches. Redirect addresses
  must be https, or http to `localhost`, `127.0.0.1` or `[::1]`; they are matched
  exactly, except that a loopback address may use any port (RFC 8252).
- Only public clients are accepted: a registration or metadata document that
  can only authenticate with a key pair is refused. One that lists several
  token methods (as ChatGPT's does) is accepted when `none` is among them,
  whatever method it prefers.
- A registration, metadata document or authorization Polaris refuses is
  logged on the server with its reason, so a connection that fails on screen
  can be diagnosed without guessing.
- PKCE with S256 is required. Codes last five minutes and work once. Answers
  carry `iss` (RFC 9207).
- The SSE endpoint is the same resource as `/api/mcp`: each request is
  answered by the `/api/mcp` handler, so the token, permissions, address rules
  and rate limits are the same, and naming `/api/mcp/sse` as the resource gets
  tokens for `/api/mcp` too. The GET opens a stream that names where to POST;
  a POST is accepted only from the credential that opened its stream (a
  refreshed token of the same connection counts), and its reply arrives on that
  stream. One connection may hold four streams open at once, 500 across the
  whole instance; a stream stays open at most 12 hours, and a credential may
  open no more than 30 a minute.
- Access tokens last an hour and work only on `/api/mcp` (and, as the same
  resource, `/api/mcp/sse`) at the address they were issued for (RFC 8707
  resource indicators). Refresh tokens last 30 days and change on every use;
  presenting an old one ends the whole connection, as does exchanging a code
  twice.
- Polaris stores only SHA-256 hashes of codes, tokens and client secrets.
- The consent page cannot be shown inside a frame.

## Troubleshooting

- **The client says it cannot reach the server.** Claude on the web and ChatGPT
  connect from their own servers, so Polaris has to be reachable from the
  internet on the address you gave them. Claude Code, Cursor and VS Code only
  need to reach it from your computer.
- **"This connection cannot continue".** Polaris does not recognize the app,
  could not read the details it publishes about itself, does not accept those
  details, or the link would send you to an address the app never registered.
  Start the connection again from the app; if it keeps happening, remove
  Polaris from the app and add it back.
- **A tool says the connection needs a scope.** Connect the app again and tick
  that permission, or ask an administrator for it if it is not offered.
- **It stopped working.** Check **Account > AI assistants**: if it is not
  listed, it was disconnected (by you, or because one of its tokens was used
  twice). Connect it again from the app.

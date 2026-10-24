# Setting up integrations

[Leer en español](integrations-setup.es.md) - [Back to the README](../README.md)

Where to click, what to paste and what each service enables. Most are set up
once by an administrator under **Management > Integrations & AI >
Integrations**: press **Set up** on a card, follow the numbered links, and paste
what the service gives you. Whatever is set up there works everywhere at once.

Where a service signs people in, the card shows an **Authorized redirect URI**
with a copy button. Paste it into the service exactly as shown: the service
refuses an authorization that arrives from any other address.

## GitHub

Lets people connect their GitHub, sign in with it and deploy their
repositories, and gives coding agents their identity.

1. Choose **Create app**, then **Create GitHub App**. GitHub asks you to
   confirm, then to choose which repositories the app can access.
2. Or choose **Existing app** and paste its App ID, private key (the contents of
   the `.pem` file), Client ID and client secret.

A personal access token also works for deploying: a fine-grained token on the
repositories you want to deploy, with Contents: Read and Deployments: Read and
write. If this Polaris has no address GitHub can reach, the app is created
without a webhook; agent triggers need one, which you can add on GitHub once a
domain is set.

## Google

Gives everyone a Connect button for their own Google account. Their events
appear in the calendar, read-only, and they can sign in with the linked account
if you allow it. On the card, follow the links in order: fill in the consent
screen (name the app exactly Polaris), add the authorized domain (Google
rejects an IP address, so this needs a domain name), prove you own the domain,
create an OAuth client of type Web application with the redirect URI, enable
the Calendar API and the Tasks API, then publish the app. Paste the Client ID
and client secret. Until the app is verified, people click through Google's
warning first.

## Microsoft

Gives everyone a Connect button for their Microsoft account, so their OneDrive
can be a backup destination. Register an application for organizational and
personal accounts, paste the redirect URI into its Web platform, and add the
delegated Files.ReadWrite permission. Paste the Application (client) ID and the
secret's value (not its id).

## Dropbox

Lets people keep backups in their Dropbox. Create an app with scoped access to
an app folder, paste the redirect URI, and grant account_info.read,
files.metadata.read/write and files.content.read/write before linking. Paste
the app key and app secret.

## Cloudflare

Polaris writes your zones' DNS records and gives each app its own tunnel, so no
ports are opened. Connect an API token for everything, for DNS only or for
tunnels only. A connector token (Zero Trust > Networks > Tunnels > Install
connector) runs a single server-wide tunnel instead.

## ngrok

Runs an ngrok agent on this server that forwards inbound traffic to Polaris.
Paste your authtoken. A reserved domain (an ngrok paid plan) gives a stable
address.

## DuckDNS

Points a free `<name>.duckdns.org` subdomain at this server's public IP and
keeps it updated, and works as a wildcard base for app subdomains. Type the
subdomain and paste the token shown at the top of the DuckDNS page once you sign
in. **Sync now** points the record at the current IP straight away.

## Steam

Lets people link their Steam account so game servers recognize them. Nothing
has to be registered: switch it on. A Web API key is optional and shows a
linked account's name and avatar instead of its Steam id.

## Epic Games

Lets people link their Epic account so game servers recognize them. The longest
setup on the screen: create a product, a client with the redirect URI, and the
application linked to that client; verify your domain; submit it for review.
Until the review passes, only accounts in your own Epic organization can
authorize. Paste the client id and secret.

## Minecraft

Lets people link their Minecraft account, so a server can be opened to them by
name. It needs its own application, separate from the Microsoft one: register
it for personal Microsoft accounts with the redirect URI, and apply for the
Minecraft API, which Microsoft approves per application. Paste the client id
and the secret's value.

## Discord

Lets people link their Discord account so game servers recognize them. Create
an application, register the redirect URI under OAuth2 > Redirects, and paste
the client id and secret from the OAuth2 tab. Signing in with Discord is a
separate switch on the card, and starts off.

## Spotify

Lets people show what they are listening to and listen along. Create an app in
Spotify's developer dashboard with the values the card lists and Web API
ticked, add each person who will link under User Management, and paste the
client id and secret. Spotify needs an https address for Polaris, and Listen
along needs Premium.

## Tenor and GIPHY

Adds GIF and sticker search to the Chat picker. Connect either: Tenor takes a
Google Cloud API key with the Tenor API enabled, GIPHY the API key from a GIPHY
app. A chosen GIF is stored in Polaris, so conversations never ask the service
for anything.

## VirusTotal

Scans files uploaded to your drop points and alerts you when something is
flagged; choose whether a detection blocks, quarantines or only notifies. Paste
the Public API key from your VirusTotal profile.

## Criminal IP

The firewall asks Criminal IP about addresses in your traffic and blocks the
ones that match the conditions you choose, in the background and cached. Paste
the API key from the My Information page.

## AI providers

Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Moonshot AI, Groq, Cerebras
and OpenRouter have their own list. Each person adds keys under **Account > AI
provider keys**, and an administrator adds the deployment's under **Management
> Integrations & AI > AI provider keys**. Keys are tried from the top; the first
one whose provider serves the model is used. The same page holds agent
accounts, which sign a coding agent in for its sessions.

## AI assistants

Claude, Cursor, Visual Studio Code, OpenCode and other MCP clients connect as
you from **Account > AI assistants**. See
[Connecting AI assistants](connecting-ai-assistants.md).

## Places devices

Devices are connected per place: open **Places > Devices** and choose **Connect
a device**. Pick what you have; each option says whether it works on the same
network or from anywhere, and lists its steps.

| Option | Reach | What you give it |
| --- | --- | --- |
| Smart Life / Tuya Smart app | From anywhere | The User Code from the app (Me > gear > Account and Security), then scan the code Polaris shows with the same app |
| Tuya cloud project | From anywhere | Access ID, Access Secret and data center of a Tuya IoT console project linked to your app account |
| Tapo on your own network | Same network | The device's IP address and your Tapo app email and password, one connection per device |
| Kasa on your own network | Same network | The device's IP address; the TP-Link account only on newer firmware |
| Shelly on your own network | Same network | The Shelly's IP address, and its password if you set one |
| Hue Bridge | Same network | The bridge's IP address; press its link button, then Connect within 30 seconds |
| DIRIGERA hub (IKEA) | Same network | The hub's IP address; select Connect, then press the hub's action button within a minute |
| Gree+ (local network) | Same network | Nothing, or a unit's IP or MAC; units must be set up in the Gree+ app first |
| Philips Air+ (local network) | Same network | Nothing, or a unit's address; purifiers must be set up in the Philips Air+ app first |
| Philips account | From anywhere | A code Philips emails you; unofficial, as Philips publishes no API |
| Philips Dynalite (Dynet gateway) | Same network | The gateway's IP address and the area numbers to bring in |
| Home Assistant | Same network | The address you open it at and a long-lived access token from your profile page |
| SwitchBot account | From anywhere | The token and secret key from Developer Options in the SwitchBot app |
| Nuki Web account | From anywhere | An API token from Nuki Web that may see and operate your locks |
| Nuki on your own network | Same network | The address and credentials of the MQTT broker you entered in the Nuki app |
| A broker on your own network | Same network | The address and credentials of an MQTT broker that devices announce themselves on |

Give a device a fixed address in your router where you can, so it keeps
answering at the address you typed. Hue Bluetooth bulbs and Philips TVs are
listed but cannot be connected; the screen says why.

## Linear and Jira

Brings a tracker's issues onto your Tasks board as tasks, keeping their
reference. Open **Account > Connected accounts**, find **Issue trackers** and
choose **Connect a tracker**. Pick the tracker, name it, and choose the space
and list its issues land in.

- Linear: a Personal API key (Linear > Settings > Security & access > Personal
  API keys). Optionally a team key, such as ENG; empty brings every issue the
  key can see.
- Jira: the site (your-company.atlassian.net), the account email and an API
  token (id.atlassian.com > Security > Create and manage API tokens).
  Optionally a JQL query; empty brings everything, newest first.

**Send status changes back** makes moving a task here move the issue there. It
starts off. **Pull now** brings changes in straight away, and disconnecting
leaves the tasks where they are.

## iCloud, Nextcloud and other CalDAV calendars

In Calendar, choose **Add a calendar > CalDAV server**. Pick iCloud, Fastmail,
Yahoo, Nextcloud (type its address) or Other server, then your username and an
app password; **How to make an app password** opens the provider's own steps.
iCloud refuses your Apple Account password. Calendars appear as they sync and
stay in step both ways.

**Subscribe by URL (.ics)** takes any calendar that publishes an .ics or webcal
link, read-only.

## Inbox: Telegram, WhatsApp, Discord and Slack

Conversations from these platforms in one place, answered from Polaris. Install
**Messaging bridge** from **Apps > Marketplace**; **Management > Inbox** then
appears. Choose **Connect channel**, pick a platform and how to connect it.

| Platform | How | What you give it |
| --- | --- | --- |
| Telegram | A @BotFather bot | The token @BotFather gives you. Bots cannot start a chat: the person opens your bot and sends /start first |
| WhatsApp (QR) | Your phone, linked by QR | Nothing: choose **Show QR**, then WhatsApp > Linked devices > Link a device. Free but unofficial; use a spare number |
| WhatsApp Cloud | Meta's official API, paid | The Meta access token and phone number id from the WhatsApp API setup page; point its webhook at this Polaris |
| Discord | A bot application | The bot token from the Developer Portal. Polaris then shows what is left: **Add the bot to a server**, and the two privileged intents to switch on under Bot > Privileged Gateway Intents |
| Discord webhook | One-way alerts | The channel's Edit > Integrations > Webhooks > New Webhook > Copy Webhook URL |
| Slack | A workspace app | Its Bot User OAuth token (starts with xoxb-) |
| Slack webhook | One-way alerts | The URL of an Incoming Webhook in your Slack app |

## UniFi UNAS

Shows a UniFi NAS in Drive with its pools, bays and backups. In Drive, under
**Locations**, choose **Add connection > UniFi UNAS** (**Detect a NAS by IP**
finds one on your network). Use a local console account, not a Ubiquiti SSO
login with 2FA.

## Docker

Monitors and manages the containers on a Docker engine. The local host appears
by itself in the full edition. For another engine, open **Containers** and
choose **Add host**, then a transport: Local socket, SSH (host Engine) with a
username and private key, or TCP with optional TLS certificates.

## Vercel, Railway and AWS

Puts the services you run there on a project's board, with what each last
released and a button to release it again. They still build and serve it.
Under **Account > Connected accounts**, choose **Use a token**:

- Vercel: an account token with access to the team the projects are under.
- Railway: an account token, which reaches every workspace; a project token
  cannot list the rest.
- AWS: an access key ID, its secret and the region your ECS services and
  Amplify branches are in. Read-only is enough to watch; releasing again needs
  ecs:UpdateService or amplify:StartJob.

Then, in a project's **Elsewhere** section, choose **Add a service**.

## GitHub Copilot

Copilot CLI runs in agent sessions already signed in with the session's GitHub
token, so nothing has to be linked. Copilot as an MCP client connects from
**Account > AI assistants**.

## Bitwarden, Vaultwarden and KeePassXC

Vault speaks the Bitwarden protocol, so Bitwarden's apps and extensions work
with it as they would with a Vaultwarden server. Open **Vault > Connect an
app**, copy **Your server address**, and on the app's sign-in screen choose
Self-hosted and paste it into Server URL. Sign in with your Polaris email and
master password.

To bring passwords in, use **Import** under **Vault > Settings**: a Bitwarden
JSON export, a KeePass XML export (KeePass and KeePassXC: File > Export) or a
CSV. A .kdbx database is not an export.

## Obsidian

In Notes, choose **Import Markdown** on a notebook and pick files, a folder or
a zipped vault. Links written as [[another note]] are connected once
everything is in.

## PostgreSQL, MySQL, MariaDB, MongoDB and Redis

Databases Polaris runs for your services are listed in **Databases** by
themselves. For any other, choose **New connection**, pick the engine and fill
in the fields, or paste a **Connection URL** and press **Import**. It can go
through one of your servers, use SSL with a choice of how strictly the
certificate is checked, and be **Read-only**.

# messaging-bridge

Runs the channel adapters (Telegram, WhatsApp Cloud, WhatsApp Web; Discord/Slack
next) behind a small bearer-authenticated HTTP API. Polaris deploys it as a managed
container so the heavier WhatsApp Web backend (Puppeteer/Chromium) stays isolated
from the web process.

The web is the source of truth: it stores channels, conversations and messages in
Postgres. The bridge holds only the live adapter connections. Inbound messages are
POSTed to the web's ingest route; outbound sends come in over the API. WhatsApp
Cloud inbound arrives on the web's Meta webhook, not here.

## Environment

- `BRIDGE_PORT` - HTTP port (default `8787`).
- `BRIDGE_TOKEN` - bearer token the web presents on every API call.
- `WEB_INGEST_URL` - the web's inbound ingest endpoint.
- `WEB_INGEST_KEY` - shared key sent as `x-internal-key` when forwarding inbound.
- `WA_SESSION_DIR` - where whatsapp-web sessions persist (default `/app/.sessions`,
  a mounted volume so a linked number survives restarts).
- `PUPPETEER_EXECUTABLE_PATH` - system Chromium for whatsapp-web (set in the image).

## API

- `GET  /health` - liveness (unauthenticated).
- `POST /channels` - connect a channel `{ channelId, platform, provider?, token?,
  config? }`; returns `{ externalId, capabilities }`.
- `GET  /channels/:id/state` - onboarding/connection state `{ status, qr?,
  externalId? }` (whatsapp-web reports its QR here).
- `GET  /channels/:id/targets` - addressable send targets grouped (server ->
  channels) for adapters that enumerate them (Discord); `{ groups }`, empty for
  platforms whose recipients are entered by hand.
- `POST /channels/:id/send` - send `{ peerId, text?, interactive? }`.
- `DELETE /channels/:id` - disconnect.

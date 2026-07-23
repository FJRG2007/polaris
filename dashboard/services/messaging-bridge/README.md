# messaging-bridge

Runs the channel adapters (Telegram today; WhatsApp/Discord/Slack next) behind a
small bearer-authenticated HTTP API. Polaris deploys it as a managed container so
the heavier WhatsApp backend (Puppeteer) stays isolated from the web process.

The web is the source of truth: it stores channels, conversations and messages in
Postgres. The bridge holds only the live adapter connections. Inbound messages are
POSTed to the web's ingest route; outbound sends come in over the API.

## Environment

- `BRIDGE_PORT` - HTTP port (default `8787`).
- `BRIDGE_TOKEN` - bearer token the web presents on every API call.
- `WEB_INGEST_URL` - the web's inbound ingest endpoint.
- `WEB_INGEST_KEY` - shared key sent as `x-internal-key` when forwarding inbound.

## API

- `GET  /health` - liveness (unauthenticated).
- `POST /channels` - connect a channel `{ channelId, platform, provider?, token }`;
  returns `{ externalId, capabilities }`.
- `POST /channels/:id/send` - send `{ peerId, text?, interactive? }`.
- `DELETE /channels/:id` - disconnect.

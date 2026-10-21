# Marketplace media

What each Marketplace app shows on its card and its page, and which real
captures are still missing.

## How media is wired

- Captures live in `docs/assets/media` as
  `<slug>-<dark|light>-<en|es>-<desktop|mobile>.webp` (all eight per slug).
- The dashboard cannot read `docs/`, so each capture an app uses is copied to
  `dashboard/apps/web/public/marketplace/` under the same name.
- `SHOTS` in `dashboard/apps/web/src/lib/apps/app-screenshots.ts` maps a catalog
  id to its slugs, in display order. The first slug is the card preview; all of
  them are the page's gallery.
- An app with no entry shows a placeholder drawn from its icon, name and
  summary on its own colour. It is never a mocked-up screen, and an app without
  a capture is never in the Featured row.
- `test/apps/app-screenshots.test.ts` fails if a mapped file is missing from
  `public/marketplace` in any theme or language.

To add a capture: take all eight files with sample data, put them in
`docs/assets/media`, copy them to `public/marketplace`, and add the slug to
`SHOTS`.

## Apps with real captures

| App          | Catalog id     | Slugs                                                                       |
| ------------ | -------------- | --------------------------------------------------------------------------- |
| Calendar     | `calendar`     | `calendar`, `calendar-time`                                                 |
| Game servers | `game-servers` | `games`, `game-players`, `game-console`, `game-inventory`, `game-events`    |
| Places       | `home`         | `places`                                                                    |

## Apps still needing captures

Each one needs the eight files (dark and light, English and Spanish, desktop
and mobile), taken on an install with sample data.

| App              | Catalog id         | Suggested slug(s)                  | What the capture should show                                                                                          |
| ---------------- | ------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Messaging bridge | `messaging-bridge` | `messaging-bridge`                 | The installed app's page with WhatsApp, Telegram, Discord and Slack connected, then the Inbox with their conversations |
| Tools            | `tools`            | `tools`, `tools-convert`           | `/tools` with the list of tools, then one conversion in progress (an image resized or a video trimmed)                |
| CRM              | `crm`              | `crm`, `crm-deal`                  | `/crm` pipeline board with deals in several stages, then one company with its people and deals                         |
| Status pages     | `status-pages`     | `status-pages`, `status-page-public` | `/status-pages` list of pages, then a public status page with its services and whether each is up                        |
| Mail server      | `mail-server`      | `mail-server`, `mail-server-dns`   | `/apps/mail-server` with a domain and its mailboxes, then the DNS records it wrote, each checked                       |
| Network filter   | `dns-blocker`      | `dns-blocker`                      | `/apps/dns-blocker` on a network in use, showing what it blocked                             |
| OpenClaw         | `openclaw`         | -                                  | Coming soon: nothing to capture until it can be installed                                                             |
| Hermes           | `hermes`           | -                                  | Coming soon: nothing to capture until it can be installed                                                             |

The existing `mail` and `mail-thread` captures show the Mail app (the inbox),
not the Mail server app, so they are not used for it.

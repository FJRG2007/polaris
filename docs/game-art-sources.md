# Where a game's picture comes from

The picture beside "Playing <game>" is fetched by the Polaris server from a
store's own public catalog, re-encoded to a 128px WebP, kept in the database and
served to readers from the Polaris host. No computer ever supplies an image. This
page records which sources were weighed, what each allows, and why the chain is
the one it is. Researched 2026-11-24.

Code: `dashboard/apps/web/src/lib/presence-activity/game-art-sources.ts` (asking a
store by id), `game-art-lookup.ts` (finding the id by name), `game-art.ts`
(caching). Fixture: `dashboard/apps/web/test/presence/fixtures/top-pc-games.json`.

## How Discord does it

Discord keeps its own curated registry of detectable games, served unauthenticated
at `https://discord.com/api/v9/applications/detectable` (about 13 MB of JSON,
roughly 25,000 entries, checked 2026-11-24). Each entry has `name`, `aliases`,
`executables`, an `icon_hash`/`cover_image_hash` on Discord's own CDN, and
`third_party_skus` that map the game to its ids in other stores (`steam`, `epic`,
`xbox`, `google_play`...). Fortnite's entry, for example, lists Xbox product
`BT5P2X999VH2` and Epic `fn`. The icons are the ones each game's registered
Discord application uploaded.

That registry is Discord's data. The endpoint is undocumented, no license is
published for reusing either the list or the images, and the Discord Developer
Terms do not grant one. Polaris therefore does not read it, mirror it, or hotlink
its CDN. What it does confirm is the technique: a curated registry keyed by store
ids, with an unknown game drawn as a generic icon. Polaris follows the same rule,
with the stores' own catalogs as the registry.

- Community notes on the detectable JSON: https://github.com/markterence/discord-quest-completer/issues/48
- Discord application resource docs (no detectable endpoint documented): https://docs.discord.com/developers/resources/application

## Sources weighed

Ranked by: no key needed, license allows display, coverage, rate limits, stability.

| Source | Key | Display allowed | Coverage outside Steam | Limits | Stability | Used |
| --- | --- | --- | --- | --- | --- | --- |
| Steam store (`storesearch`, `IStoreBrowseService/GetItems`) | none | publisher store assets, shown to identify the game (Steam Web API Terms) | Steam only | 100,000 Web API calls/day | high; Valve's own clients use them | yes, by id and by name |
| Microsoft Store catalog (`displaycatalog.mp.microsoft.com`) | none | no terms published for the catalog; the publisher's store art, shown only to identify the game, as with Steam | Fortnite, Valorant, League of Legends, Genshin Impact, Minecraft, Roblox, Fall Guys, Xbox PC catalog | not published; one lookup per name per server | high; the Windows Store client reads it, undocumented | yes, by name and Wikidata id |
| Wikidata (`query.wikidata.org`) | none | data CC0; ids only, no images taken | cross-store ids: Steam P1733, GOG P2725, Microsoft Store P5885, Epic P6278 | 60 s of query time per minute per client, 5 parallel per IP, 429 with Retry-After; a descriptive User-Agent required | high; documented public service | yes, for ids |
| GOG (`api.gog.com/products`) | none | no terms published; the publisher's store art, shown only to identify the game | GOG only | not published | high | yes, by id (from the desktop or Wikidata) |
| Epic store content (`store-content-ipv4.ak.epicgames.com/api/<locale>/content/products/<slug>`) | none | no terms published | Epic | not published | low; legacy CMS endpoint, undocumented, fields absent on some products | no - every popular Epic game is also in the Microsoft Store catalog |
| PCGamingWiki (Cargo API) | none for reads, but arbitrary Cargo queries are refused (`permissiondenied`, checked 2026-11-24) | text CC BY-NC-SA; cover images are non-free uploads | wide, PC focused | - | medium | no - queries refused, covers not licensed for reuse |
| IGDB | Twitch client id + OAuth client-credentials token | commercial use needs an IGDB partnership and visible attribution | wide | 4 requests/s, 8 concurrent per client id | high | no - keyed; a candidate optional operator provider |
| SteamGridDB | personal API key | images are user uploads, no license; DMCA takedowns reported | wide | not published | medium | no - keyed and unlicensed art |
| RAWG | API key | free tier non-commercial, a backlink on every page using the data | wide | 20,000 requests/month free | medium | no - keyed, attribution on every page |

Sources:

- Steam Web API Terms of Use: https://steamcommunity.com/dev/apiterms
- Wikidata Query Service limits and User-Agent policy: https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual
- Wikidata properties: https://www.wikidata.org/wiki/Property:P1733 (Steam), https://www.wikidata.org/wiki/Property:P2725 (GOG), https://www.wikidata.org/wiki/Property:P5885 (Microsoft Store), https://www.wikidata.org/wiki/Property:P6278 (Epic Games Store)
- IGDB commercial use: https://discuss.dev.twitch.com/t/commercial-use-of-igdb-api/23567 and rate limits: https://discuss.dev.twitch.com/t/response-headers-oauth-access-tokens-getting-rate-limited/46963
- SteamGridDB keys: https://www.github.com/sonic2kk/steamtinkerlaunch/wiki/SteamGridDB; takedowns: https://www.pcgamer.com/nintendo-dmcas-third-party-steam-image-site-users-upload-even-more-artwork-in-response
- RAWG API terms: https://rawg.io/apidocs and https://rawg.io/tos_api
- Playnite asks an ordered list of metadata sources and stops at the first that has the field; it ships with an IGDB metadata source: https://api.playnite.link/docs/manual/library/games/metadata.html

## The chain

A game whose program the curated list knows, or whose store id a desktop app
reported (Steam, GOG), is asked of that store directly. Everything else -
Epic, Riot, Battle.net, Xbox, a program somebody added themselves - is looked up
once per server by its name:

1. Steam store search.
2. Microsoft Store suggestions (games only).
3. Wikidata: the one video game item (P31 = Q7889) whose English label or alias is
   the name; its Steam id, else GOG, else Microsoft Store id.

A match is the store's title and the reported name being equal after
normalization (trademark signs, accents, case and punctuation dropped; `&` read
as "and"). No fuzzy matching: two games with the title at one step is ambiguous
and ends the chain, because a wrong logo is worse than the game glyph.

Caching and limits:

- `GameArtName` keeps each name's answer: a found id for 90 days, a miss for
  7 days (then asked again), and a miss older than 30 days is deleted.
- A source that did not answer is never remembered as one that had nothing.
- One lookup per name in flight, shared by readers asking at once.
- At most 20 lookups a minute per server (up to three requests each), through
  the guarded fetch with its SSRF checks and size caps; readers are limited to 600
  pictures a minute each.

## Top PC games

The fixture records what the sources answered for 57 of the most played PC games
on 2026-11-24; the test runs the chain against those answers. 52 resolve to
store art, including Fortnite, Valorant, League of Legends, Genshin Impact, Fall
Guys (Microsoft Store), and Minecraft and Roblox (Wikidata to the Microsoft
Store). The rest draw the glyph, each for a reason:

| Game | Why the glyph |
| --- | --- |
| Overwatch 2 | Renamed Overwatch; no store sells a game titled Overwatch 2. `overwatch.exe` is drawn from its curated Steam id. |
| World of Warcraft | Battle.net only, which publishes no catalog; no store id on Wikidata. |
| Hearthstone | Battle.net only; no store id on Wikidata. |
| Honkai: Star Rail | HoYoPlay and Epic only; no Steam, GOG or Microsoft Store id on Wikidata. |
| osu! | Distributed from its own site; no store id on Wikidata. |

## Not built

- **Keyed providers (IGDB first).** Would cover the Battle.net and HoYoPlay games
  above. IGDB needs a Twitch client id and secret the operator registers, and its
  commercial use needs a partnership, so it could only ever be an operator's own
  opt-in, default off. Not built: the keyless chain already covers every listed
  game a store sells, and an operator setting with credentials is a screen, a
  stored secret and a token refresh for the five titles above.
- **Epic by slug.** Wikidata's P6278 gives Epic slugs and the store-content
  endpoint answers them, but it is a legacy undocumented CMS endpoint; every
  popular Epic title in the fixture is in the Microsoft Store catalog.
- **Non-Latin titles.** A name with no Latin letters or digits normalizes to
  nothing and draws the glyph.

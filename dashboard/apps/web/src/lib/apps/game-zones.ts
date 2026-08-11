/**
 * Which game labels this Polaris actually mints hostnames under.
 *
 * A game server's name lives under its game's own label - `survival.mc.example.com`,
 * `island.ark.example.com` - and every one of those needs a wildcard record behind it
 * or each server has to buy its own. This is the list of labels the domain setup has
 * to ask for.
 *
 * Which is the games somebody is actually running, not the games Polaris knows how
 * to run. There is one app for all of them now, so having it installed says nothing
 * about which games are in use - and asking an operator for a `*.ark` record they
 * will never need is a checklist item that can only ever be red. A game earns its
 * record by having a server, which is also the moment the record starts mattering.
 *
 * The per-game manager apps still count, for the instances that have one and have
 * not opened the page that adopts it yet.
 *
 * Derived rather than stored, deliberately. Keeping game zones in the `domain.zones`
 * Setting would mean migrating every existing layout, and would leave a zone behind
 * pointing at a game that has since been removed.
 *
 * Instance-wide rather than per-owner: DNS is not scoped to whoever installed the
 * game, and a record that exists once serves every owner's servers.
 *
 * Its own module, and a deliberately narrow one: `games-service` reaches the game
 * hostname code, which reaches the DNS code that calls this, so importing it there
 * would close a cycle.
 */

import { prisma } from "@polaris/db";
import { GAMES, type GameDefinition } from "@/lib/apps/games-catalog";

/** Every game this Polaris has a server of, in catalog order. */
export async function installedGames(): Promise<GameDefinition[]> {
    const catalogIds = GAMES.flatMap((game) => [game.legacyManagerCatalogId, ...game.serverCatalogIds]);
    const installs = await prisma.installedApp.findMany({
        where: { catalogId: { in: catalogIds }, status: { not: "removed" } },
        select: { catalogId: true }
    });
    // Deduplicated here rather than with `distinct`, which is not portable across
    // every provider this schema runs on.
    const present = new Set(installs.map((install) => install.catalogId));
    return GAMES.filter(
        (game) =>
            present.has(game.legacyManagerCatalogId) ||
            game.serverCatalogIds.some((catalogId) => present.has(catalogId))
    );
}

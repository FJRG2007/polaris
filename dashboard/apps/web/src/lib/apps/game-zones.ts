/**
 * Which game labels this Polaris actually mints hostnames under.
 *
 * A game server's name lives under its game's own label - `survival.mc.example.com`,
 * `island.ark.example.com` - and every one of those needs a wildcard record behind it
 * or each server has to buy its own. This is the list of labels the domain setup has
 * to ask for, which is the games whose manager app is installed: a Polaris with no ARK
 * on it should not be shown a record for `*.ark`, and a game turned on later adds its
 * record to the checklist without anything having to be migrated.
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

/** Every game this Polaris can create servers of, in catalog order. */
export async function installedGames(): Promise<GameDefinition[]> {
    const managerIds = GAMES.map((game) => game.managerCatalogId);
    const installs = await prisma.installedApp.findMany({
        where: { catalogId: { in: managerIds }, status: { not: "removed" } },
        select: { catalogId: true }
    });
    // Deduplicated here rather than with `distinct`, which is not portable across
    // every provider this schema runs on.
    const installed = new Set(installs.map((install) => install.catalogId));
    return GAMES.filter((game) => installed.has(game.managerCatalogId));
}

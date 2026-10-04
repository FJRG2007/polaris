/**
 * Reading an arena's hits off the game (`hits.ts`): the events data pack put
 * on for a run that needs it, what it tagged since the last look taken in one
 * batch, and who last hurt a player asked of the game itself.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as commands from "../commands";
import type { KindContext } from "./arena-game";
import * as packService from "./snowball-pack-service";

/** Whether the pack is on, by run: asked once, and again after a restart. */
const packs = new Map<string, boolean>();

/**
 * Whether the pack's hits can be read in this run: put on - written where its
 * files are missing or older, taken in with `/datapack` - the first time it is
 * asked. A server where it cannot be put on plays by the game's statistics.
 */
export async function ensure(ctx: KindContext): Promise<boolean> {
    const known = packs.get(ctx.run.id);
    if (known !== undefined) return known;
    const on = await packService.ensurePack(ctx.server).catch((error) => {
        console.warn("polaris: the event pack could not be put on", String(error));
        return false;
    });
    if (!on)
        console.warn("polaris: an arena's hits are read by statistics", ctx.server.installedAppId);
    if (packs.size >= 16) packs.delete(packs.keys().next().value!);
    packs.set(ctx.run.id, on);
    return on;
}

/** Who struck a player, and who a player struck, since the last look, in lower case. */
export interface Taken {
    readonly struck: ReadonlySet<string>;
    readonly hurt: ReadonlySet<string>;
}

/** What the pack tagged since the last look; null when it is not on. */
export async function take(ctx: KindContext): Promise<Taken | null> {
    if (!(await ensure(ctx))) return null;
    await ctx.server.sayAll(hits.TAKE);
    const names = async (tag: string) =>
        new Set(
            commands
                .readWhere(await ctx.server.say([arena.readTagged(tag)]))
                .map((one) => one.name.toLowerCase())
        );
    return { struck: await names(hits.WAS_STRUCK_TAG), hurt: await names(hits.WAS_HURT_TAG) };
}

/**
 * Who last hurt each of these players in the last five seconds, by the hurt
 * player's name in lower case, as the game remembers it: null where nothing
 * did. From 1.19.4, which can ask; before it nobody is in the answer, and the
 * caller judges by where everybody is. The one who hurt them may be anything
 * living: the caller keeps only the players it knows.
 */
export async function attackers(
    ctx: KindContext,
    victims: Iterable<string>
): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    const asked = new Map([...victims].map((name) => [name.toLowerCase(), name]));
    if (asked.size === 0 || !(await ctx.atLeast(hits.ON_ATTACKER))) return found;
    for (const [key, victim] of asked) {
        const by = commands.readWhere(await ctx.server.say([hits.attackerLine(victim)]))[0];
        found.set(key, by?.name ?? null);
    }
    return found;
}

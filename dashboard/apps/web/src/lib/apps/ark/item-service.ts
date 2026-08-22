/**
 * Handing an ARK player something.
 *
 * The whole of the difficulty is the target. ARK's give commands come in three
 * shapes and two of them - `GiveItem` and `GFI` - put the item in the inventory of
 * whoever typed them, which over RCON is nobody. The third names its player, and
 * it names them by an in-game number that no command reliably reports: the one
 * that is supposed to (`GetPlayerIDForSteamID`) has answered with something else
 * for years. So the number is read out of the survivor's own file, which is where
 * it actually lives - see `profile.ts`.
 *
 * What the server does not do is answer. A give that worked and a give that was
 * ignored both come back as silence, so nothing here claims it landed; the screen
 * says what was sent and to whom.
 */

import { readArkPlayerId, runArkCommand } from "@/lib/apps/ark/service";
import { findArkItem, type ArkCatalogItem } from "@/lib/apps/ark/item-catalog";
import { arkGiveCommand, MAX_ARK_GIVE, MAX_ARK_QUALITY, type ArkGiveLine } from "@/lib/apps/ark/items";

/** Why a give did not happen, in the words a screen uses. */
export class ArkGiveError extends Error {}

/**
 * The in-game id for somebody, or a refusal that says why there is not one.
 *
 * Three different reasons, and they are worth telling apart: a server that is off
 * has no files to read, a player who has never joined has no file, and a file that
 * does not carry the number is a version this cannot read. Shared by everything
 * that acts on a particular player.
 */
export async function requireArkPlayerId(
    ownerId: string,
    installedAppId: string,
    steamId: string
): Promise<string> {
    const id = await readArkPlayerId(ownerId, installedAppId, steamId);
    if (id) return id;
    throw new ArkGiveError(
        "ARK knows this player by a number kept in their own survivor file, and there is none to read. They have to have played on this server at least once, and the server has to be running."
    );
}

export interface ArkGiveResult {
    readonly item: ArkCatalogItem;
    /** How many stacks that quantity arrives as, so the screen can say. */
    readonly stacks: number;
    /** Whatever the server printed, which is usually nothing at all. */
    readonly output: string;
}

/**
 * Put items in somebody's inventory, in the order they were asked for.
 *
 * Several at a time, because handing somebody a set of gear is one errand and not
 * four - and the expensive half of it is the same either way: the in-game id is
 * read out of the survivor's own file, once here rather than once per item.
 *
 * Everything that can be refused is refused before anything is sent, so the two
 * ordinary failures - an item the catalogue does not know, a player with no file
 * to read - leave nobody half-given. A command that dies part way through cannot
 * be taken back, so the refusal says how far it got instead of pretending it did
 * nothing.
 */
export async function giveArkItems(
    ownerId: string,
    installedAppId: string,
    steamId: string,
    requests: readonly ArkGiveLine[]
): Promise<ArkGiveResult[]> {
    if (requests.length === 0) return [];
    const items = requests.map((request) => {
        const item = findArkItem(request.key);
        if (!item) throw new ArkGiveError("That is not an item this server's catalog knows");
        return item;
    });
    const playerId = await requireArkPlayerId(ownerId, installedAppId, steamId);

    const given: ArkGiveResult[] = [];
    for (const [index, request] of requests.entries()) {
        const item = items[index]!;
        const quantity = Math.max(1, Math.min(MAX_ARK_GIVE, Math.trunc(request.quantity)));
        const quality = Math.max(0, Math.min(MAX_ARK_QUALITY, Math.trunc(request.quality)));
        try {
            const output = await runArkCommand(
                ownerId,
                installedAppId,
                arkGiveCommand({
                    playerId,
                    blueprintPath: item.bp,
                    quantity,
                    quality,
                    blueprint: request.blueprint
                })
            );
            given.push({
                item,
                // A blueprint is one piece of paper however many were asked for, so
                // the sentence about stacks would be wrong for it.
                stacks: request.blueprint ? quantity : Math.ceil(quantity / Math.max(1, item.stack)),
                output: output.trim()
            });
        } catch (caught) {
            const reason = caught instanceof Error ? caught.message : "the server stopped answering";
            throw new ArkGiveError(
                given.length === 0
                    ? reason
                    : `The first ${given.length} of ${requests.length} were sent. The rest were not: ${reason}`
            );
        }
    }
    return given;
}

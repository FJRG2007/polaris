/**
 * Giving, taking and emptying a player's items as one decision each: done now
 * while the player is on, written down for their next join while they are not,
 * and recorded in the audit when it happens. The Players panel and a connected
 * assistant both come through here, so neither can skip the queue or the audit
 * line, and an assistant's line says it was one (`via`).
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { getServerPlayers } from "./service";
import { queueAction } from "./queue-service";
import {
    clearInventory,
    clearItem,
    giveItem,
    transferInventory,
    type BagTransfer
} from "./item-service";

const { recordAudit } = host.auditService;

/** Whose bag, on which server, changed by whom. */
export interface ItemTarget {
    readonly ownerId: string;
    readonly installedAppId: string;
    readonly actorId: string;
    readonly player: string;
    /** Set when the change did not come from the panel: "mcp". */
    readonly via?: string;
}

/** Done now, with what the server said, or written down for their next join. */
export type ItemOutcome =
    | { readonly queued: true }
    | { readonly queued: false; readonly output: string };

/** Whether a player is on now, by the list the server answers with. A server
 *  that does not answer has nobody on. */
export async function isPlayerOnline(
    ownerId: string,
    installedAppId: string,
    player: string
): Promise<boolean> {
    const status = await getServerPlayers(ownerId, installedAppId).catch(() => null);
    return (
        status?.players.players.some((name) => name.toLowerCase() === player.toLowerCase()) === true
    );
}

function audit(target: ItemTarget, action: string, metadata: Record<string, unknown>) {
    return recordAudit({
        actorId: target.actorId,
        action,
        targetType: "installedApp",
        targetId: target.installedAppId,
        metadata: { ...metadata, ...(target.via ? { via: target.via } : {}) }
    });
}

/** Put a number of one item in a player's bag. */
export async function givePlayerItems(
    target: ItemTarget,
    item: string,
    count: number
): Promise<ItemOutcome> {
    const { ownerId, installedAppId, player } = target;
    // `/give` needs somebody standing there. Deciding at four in the afternoon
    // to hand something to a player who is asleep is the ordinary case, so it
    // is written down and happens when they next join.
    if (!(await isPlayerOnline(ownerId, installedAppId, player))) {
        await queueAction({
            installedAppId,
            username: player,
            payload: { kind: "give", item, count },
            requestedById: target.actorId
        });
        return { queued: true };
    }
    const { given, output } = await giveItem(ownerId, installedAppId, player, item, count);
    await audit(target, "minecraft.give", { player, item, count: given });
    return { queued: false, output: output.trim() };
}

/** Take a number of one item away, wherever it is in the bag. */
export async function takePlayerItems(
    target: ItemTarget,
    item: string,
    count: number
): Promise<ItemOutcome> {
    const { ownerId, installedAppId, player } = target;
    if (!(await isPlayerOnline(ownerId, installedAppId, player))) {
        await queueAction({
            installedAppId,
            username: player,
            payload: { kind: "clear", item, count },
            requestedById: target.actorId
        });
        return { queued: true };
    }
    const output = await clearItem(ownerId, installedAppId, player, item, count);
    await audit(target, "minecraft.inventory-take", { player, item, count });
    return { queued: false, output: output.trim() };
}

/** Empty everything a player carries, armour and offhand included. */
export async function emptyPlayerInventory(target: ItemTarget): Promise<ItemOutcome> {
    const { ownerId, installedAppId, player } = target;
    if (!(await isPlayerOnline(ownerId, installedAppId, player))) {
        await queueAction({
            installedAppId,
            username: player,
            payload: { kind: "clear-all" },
            requestedById: target.actorId
        });
        return { queued: true };
    }
    const output = await clearInventory(ownerId, installedAppId, player);
    await audit(target, "minecraft.inventory-empty", { player });
    return { queued: false, output: output.trim() };
}

/** Send everything one player carries to another. Both must be on: there is
 *  no queue for it, since what arrives depends on the bag at that moment. */
export async function sendPlayerInventory(target: ItemTarget, to: string): Promise<BagTransfer> {
    const { ownerId, installedAppId, player } = target;
    const result = await transferInventory(ownerId, installedAppId, player, to);
    await audit(target, "minecraft.inventory-send-all", {
        from: player,
        to,
        moved: result.moved,
        kept: result.kept
    });
    return result;
}

/**
 * Changing what a player is carrying.
 *
 * Everything here writes one slot at a time, because that is the only shape the
 * game offers for a player: `/data modify` refuses player entities outright, so
 * there is no way to hand the server a whole bag and no way to make two slots
 * change together. A move is therefore two writes, and the window between them
 * is real - which is why every one of them looks at the slot first.
 *
 * The stack is never rebuilt from what a screen believed. It is read back from
 * the server and re-emitted through `itemArgument`, so a sword arrives at its new
 * slot with the enchantments it left with, or does not arrive at all.
 */

import { prisma } from "@polaris/db";
import { stripFormatting } from "./parse";
import { normalizeItemId, stacksFor } from "./items";
import { parseStack, type InventoryItem } from "./inventory";
import { withServerContainer, type ServerContainer } from "./service";
import { recentlyGivenItems as recentlyGiven } from "@/lib/apps/recent-items";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { AIR, itemArgument, replaceSlot, type ItemArgumentRefusal } from "./item-argument";

/** Which spelling of the replace command this server took. `item replace` is
 *  1.17 and later; `replaceitem` is what came before it. */
type ItemCommand = "item" | "replaceitem";

const COMMAND_KEY = "itemCommand";

/** What the older servers answer when handed a command they do not have. */
const UNKNOWN_COMMAND = /unknown or incomplete command/i;

/** Why a write did not happen, in the words the screen uses. */
export type WriteRefusal = ItemArgumentRefusal | "moved" | "gone" | "unsupported" | "occupied" | "indivisible";

export class ItemWriteError extends Error {
    constructor(
        readonly why: WriteRefusal,
        message: string
    ) {
        super(message);
    }
}

const REFUSALS: Record<WriteRefusal, string> = {
    unreadable:
        "That stack carries data Polaris cannot write back exactly, so moving it would strip it. Give the item again instead.",
    "too-long": "That stack carries more data than one command can hold, so it cannot be moved without losing some.",
    moved: "They moved that stack while you were dragging it. The slot was left alone.",
    gone: "That slot is empty now. The slot was left alone.",
    unsupported: "This server is older than the command that moves an item into a slot (Minecraft 1.17).",
    occupied: "Drop part of a stack on an empty slot. Splitting onto an occupied one is not something the game does.",
    indivisible: "That stack carries its own data, so the items in it are not interchangeable and cannot be split."
};

function refuse(why: WriteRefusal): never {
    throw new ItemWriteError(why, REFUSALS[why]);
}

/** The stack in one slot right now, straight from the server. */
export async function readSlot(
    server: ServerContainer,
    player: string,
    slot: number
): Promise<InventoryItem | null> {
    const reply = await server.say(["data", "get", "entity", player, `Inventory[{Slot:${slot}b}]`]);
    return parseStack(stripFormatting(reply));
}

/** Whether two stacks are the same one, for a write that is about to overwrite
 *  what it read. Compared on everything, data included: a sword that lost a
 *  point of durability while the dialog was open is not the sword picked up. */
function sameStack(left: InventoryItem | null, right: InventoryItem | null): boolean {
    if (left === null || right === null) return left === right;
    return (
        left.id === right.id &&
        left.count === right.count &&
        (left.data?.snbt ?? null) === (right.data?.snbt ?? null)
    );
}

/**
 * Put a stack in a slot, or empty it.
 *
 * The command is chosen once per server and remembered: the modern one is tried,
 * and a server that does not have it says so in a sentence this recognises rather
 * than in an exit code.
 */
async function writeSlot(
    server: ServerContainer,
    installedAppId: string,
    player: string,
    slot: number,
    argument: string,
    count: number
): Promise<void> {
    const named = replaceSlot(slot);
    if (!named) refuse("unsupported");
    const stored = await storedCommand(installedAppId);
    const first = stored ?? "item";
    const reply = await server.say(argv(first, player, named, argument, count));
    if (!UNKNOWN_COMMAND.test(stripFormatting(reply))) {
        if (!stored) await patchInstallConfig(installedAppId, { [COMMAND_KEY]: first });
        return;
    }
    // Only reached on a server that has neither spelling, or an older one seen
    // for the first time. Either way the answer is one more attempt, not a guess.
    if (first === "replaceitem") refuse("unsupported");
    const legacy = await server.say(argv("replaceitem", player, named, argument, count));
    if (UNKNOWN_COMMAND.test(stripFormatting(legacy))) refuse("unsupported");
    await patchInstallConfig(installedAppId, { [COMMAND_KEY]: "replaceitem" });
}

function argv(
    command: ItemCommand,
    player: string,
    slot: string,
    argument: string,
    count: number
): string[] {
    return command === "item"
        ? ["item", "replace", "entity", player, slot, "with", argument, String(count)]
        : ["replaceitem", "entity", player, `slot.${slot}`, argument, String(count)];
}

async function storedCommand(installedAppId: string): Promise<ItemCommand | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    const stored = readInstallConfig(row?.config)[COMMAND_KEY];
    return stored === "item" || stored === "replaceitem" ? stored : null;
}

/** Empty one slot. */
export async function clearSlot(ownerId: string, installedAppId: string, player: string, slot: number): Promise<void> {
    await withServerContainer(ownerId, installedAppId, async (server) => {
        await writeSlot(server, installedAppId, player, slot, AIR, 1);
    });
}

/** Put an item into a slot, replacing whatever was there. Used by the palette,
 *  where the stack is new and carries nothing to lose. */
export async function giveToSlot(
    ownerId: string,
    installedAppId: string,
    player: string,
    slot: number,
    itemId: string,
    count: number
): Promise<void> {
    await withServerContainer(ownerId, installedAppId, async (server) => {
        await writeSlot(server, installedAppId, player, slot, itemId, count);
    });
}

/**
 * Move a stack from one slot to another, swapping with whatever is in the way.
 *
 * Both slots are read first and compared against what the screen was showing.
 * That does not close the window - RCON has no transaction, and the player is
 * playing - but it turns the common case of a stale dialog from a destroyed item
 * into a refusal that says so.
 */
export async function moveStack(
    ownerId: string,
    installedAppId: string,
    player: string,
    from: number,
    to: number,
    expected: { readonly from: InventoryItem | null; readonly to: InventoryItem | null },
    /** How many to move. Absent, or the whole stack, moves all of it. Fewer
     *  splits, which the game does with a right-click and a modifier. */
    count?: number
): Promise<void> {
    if (from === to) return;
    await withServerContainer(ownerId, installedAppId, async (server) => {
        const [source, target] = await Promise.all([readSlot(server, player, from), readSlot(server, player, to)]);
        if (source === null) refuse("gone");
        if (!sameStack(source, expected.from) || !sameStack(target, expected.to)) refuse("moved");

        // Both arguments are built before either slot is written. Half a swap is
        // the one outcome worth going out of the way to avoid: it would leave the
        // player holding two copies of one stack and none of the other.
        const moving = itemArgument(source);
        if (!moving.ok) refuse(moving.why);

        const part = count === undefined ? source.count : Math.max(1, Math.min(count, source.count));
        if (part < source.count) {
            // A split is two writes of the same item, so nothing has to be
            // reconstructed and nothing can be lost - but only for a stack whose
            // items are interchangeable. One carrying its own data is one item
            // wearing that data, and there is no half of it.
            if (source.data !== null) refuse("indivisible");
            if (target !== null) refuse("occupied");
            await writeSlot(server, installedAppId, player, to, moving.value, part);
            await writeSlot(server, installedAppId, player, from, moving.value, source.count - part);
            return;
        }

        const displaced = target ? itemArgument(target) : null;
        if (displaced && !displaced.ok) refuse(displaced.why);
        await writeSlot(server, installedAppId, player, to, moving.value, source.count);
        if (displaced && target) {
            await writeSlot(server, installedAppId, player, from, displaced.value, target.count);
        } else {
            await writeSlot(server, installedAppId, player, from, AIR, 1);
        }
    });
}

/** Take a number of one item away, wherever it is in the bag. What `clear` is
 *  for, and the only write here that is not about a particular slot. */
export async function clearItem(
    ownerId: string,
    installedAppId: string,
    player: string,
    itemId: string,
    count: number
): Promise<string> {
    return withServerContainer(ownerId, installedAppId, (server) =>
        server.say(["clear", player, itemId, String(count)])
    );
}

/**
 * Hand a player an amount, as the stacks it actually arrives as.
 *
 * `/give` is issued once per stack rather than once with a big number. The count
 * argument's ceiling is a version detail nobody operating a panel should have to
 * know, and a refusal at the far end - after some of it went in - is a harder
 * thing to report than one stack that did not.
 *
 * Returns what the server said about each, so a partial delivery can say which
 * part happened rather than reporting the last line as the whole story.
 */
export async function giveItem(
    ownerId: string,
    installedAppId: string,
    player: string,
    itemId: string,
    total: number
): Promise<{ given: number; output: string }> {
    const stacks = stacksFor(itemId, total);
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const said: string[] = [];
        let given = 0;
        for (const stack of stacks) {
            said.push(stripFormatting(await server.say(["give", player, itemId, String(stack)])).trim());
            given += stack;
        }
        return { given, output: said.filter(Boolean).join("\n") };
    });
}

/** What has recently been handed out on this server, most recent first - the
 *  palette opens on it rather than on the whole catalogue. Read from the audit
 *  log; see `recent-items`, which ARK's picker shares. */
export async function recentlyGivenItems(installedAppId: string, limit = 12): Promise<string[]> {
    return recentlyGiven("minecraft.give", installedAppId, normalizeItemId, limit);
}

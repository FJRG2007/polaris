/**
 * What a Minecraft player carries, changed by a connected assistant: give an
 * item, take some away, empty the bag, or send everything to another player.
 *
 * The Players panel's own buttons, held to the grant they are held to
 * (`games.moderate` on the server) and done through the same functions
 * (`minecraft/item-operations.ts`): a player who is not on has the change
 * written down for their next join, and each one leaves the panel's audit
 * line, marked as coming from an assistant. Reading the bag is
 * `games_player_inventory`.
 *
 * The scope is the moderators' (`gameservers.moderate`), or the managers'
 * (`gameservers.manage`), whose console already reaches `/give` and `/clear`.
 *
 * Server-only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { ITEM_ID_PATTERN } from "./minecraft/items";
import type { AppHostTypes } from "@polaris/app-host";
import { attempt, onlyFor, refuse, serverFor, serverId } from "./mcp-common";

type McpTool = AppHostTypes["McpTool"];
type McpCaller = AppHostTypes["McpCaller"];

/** The work, loaded when a tool runs: it reaches the server's container and
 *  the database, which listing the tools has no need of. */
const operations = () => import("./minecraft/item-operations");

/** A bag's worth: 36 slots of 64, the ceiling the panel holds an amount to. */
const MAX_ITEMS = 2304;

const player = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,16}$/, "A Minecraft account name")
    .describe("The player's Minecraft name, as games_players lists them.");

const item = z
    .string()
    .trim()
    .toLowerCase()
    .regex(ITEM_ID_PATTERN, "An item id, such as minecraft:diamond or diamond")
    .describe(
        'The item id, namespace optional: "minecraft:diamond", "diamond", or a mod\'s "create:wrench". games_player_inventory shows the ids a player holds.'
    );

const count = z.number().int().min(1).max(MAX_ITEMS);

/** The caller's standing to change a bag on a Minecraft server, and who for. */
async function targetFor(caller: McpCaller, server: string, name: string) {
    const { user, access } = await serverFor(caller, server, "games.moderate");
    onlyFor(access, ["minecraft"], "Changing what a player carries");
    return {
        name: access.install.name,
        target: {
            ownerId: access.ownerId,
            installedAppId: server,
            actorId: user.id,
            player: name,
            via: "mcp"
        }
    };
}

/** "Queued for their next join", or what the server said. */
function outcomeText(outcome: { queued: boolean; output?: string }, now: string, later: string) {
    if (outcome.queued) return later;
    return outcome.output ? `${now}\n${outcome.output}` : now;
}

const giveTool = () =>
    host.mcp.defineTool({
        name: "games_player_give",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Give a Minecraft player items",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Put a number of one item in a Minecraft player's inventory, as the player panel's Give does. Arrives as full stacks. When the player is not on, it is queued and handed over when they next join.",
        input: z.object({
            serverId,
            player,
            item,
            count: count.describe(`How many in total, up to ${MAX_ITEMS} (a full inventory).`)
        }),
        category: "games",
        scope: ["gameservers.moderate", "gameservers.manage"],
        readOnly: false,
        destructive: false,
        async run(input, caller) {
            const { name, target } = await targetFor(caller, input.serverId, input.player);
            const { givePlayerItems } = await operations();
            const done = await attempt(() => givePlayerItems(target, input.item, input.count));
            return {
                text: outcomeText(
                    done,
                    `Gave ${input.count} ${input.item} to ${input.player} on ${name}.`,
                    `${input.player} is not on ${name}; ${input.count} ${input.item} will be given when they next join.`
                ),
                structured: { serverId: input.serverId, player: input.player, ...done }
            };
        }
    });

const takeTool = () =>
    host.mcp.defineTool({
        name: "games_player_take",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Take items from a Minecraft player",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Remove a number of one item from a Minecraft player's inventory, wherever it is in it, as the player panel's Take does. When the player is not on, it is queued for their next join. Confirm with the person first.",
        input: z.object({
            serverId,
            player,
            item,
            count: count.describe(`How many to take, up to ${MAX_ITEMS}.`)
        }),
        category: "games",
        scope: ["gameservers.moderate", "gameservers.manage"],
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { name, target } = await targetFor(caller, input.serverId, input.player);
            const { takePlayerItems } = await operations();
            const done = await attempt(() => takePlayerItems(target, input.item, input.count));
            return {
                text: outcomeText(
                    done,
                    `Took up to ${input.count} ${input.item} from ${input.player} on ${name}.`,
                    `${input.player} is not on ${name}; ${input.count} ${input.item} will be taken when they next join.`
                ),
                structured: { serverId: input.serverId, player: input.player, ...done }
            };
        }
    });

const emptyTool = () =>
    host.mcp.defineTool({
        name: "games_player_inventory_empty",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Empty a Minecraft player's inventory",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Remove everything a Minecraft player carries, armour and offhand included. Cannot be undone. When the player is not on, it is queued for their next join. Confirm with the person first.",
        input: z.object({ serverId, player }),
        category: "games",
        scope: ["gameservers.moderate", "gameservers.manage"],
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { name, target } = await targetFor(caller, input.serverId, input.player);
            const { emptyPlayerInventory } = await operations();
            const done = await attempt(() => emptyPlayerInventory(target));
            return {
                text: outcomeText(
                    done,
                    `Emptied ${input.player}'s inventory on ${name}.`,
                    `${input.player} is not on ${name}; their inventory will be emptied when they next join.`
                ),
                structured: { serverId: input.serverId, player: input.player, ...done }
            };
        }
    });

const sendTool = () =>
    host.mcp.defineTool({
        name: "games_player_inventory_send",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Move a Minecraft player's inventory to another player",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Send everything one Minecraft player carries to another, stack by stack, enchantments and names kept. Both must be on. A stack whose data cannot be written back exactly stays with the sender and is counted as kept. Confirm with the person first.",
        input: z.object({
            serverId,
            player: player.describe("Who the items come from, as games_players lists them."),
            to: player.describe("Who receives them.")
        }),
        category: "games",
        scope: ["gameservers.moderate", "gameservers.manage"],
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            if (input.player.toLowerCase() === input.to.toLowerCase())
                refuse("The sender and the receiver are the same player.");
            const { name, target } = await targetFor(caller, input.serverId, input.player);
            const { sendPlayerInventory } = await operations();
            const result = await attempt(() => sendPlayerInventory(target, input.to));
            return {
                text: `Sent ${result.moved} stack(s) from ${input.player} to ${input.to} on ${name}${result.kept > 0 ? `; ${result.kept} stayed with ${input.player}` : ""}.`,
                structured: {
                    serverId: input.serverId,
                    from: input.player,
                    to: input.to,
                    moved: result.moved,
                    kept: result.kept
                }
            };
        }
    });

export const itemTools: readonly (() => McpTool)[] = [giveTool, takeTool, emptyTool, sendTool];

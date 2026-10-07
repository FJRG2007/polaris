/**
 * The players on a game server, as tools a connected assistant can call.
 *
 * The Players tab's own buttons, held to the grants they are held to: seeing
 * who is on, who may join and who is kept out is `games.read`; kicking,
 * banning, timing out and the whitelist are the moderators' (`games.moderate`,
 * reached through the `gameservers.moderate` scope); who may ever connect, and
 * from where, is the managers' (`games.manage`), because it decides who can get
 * in at all rather than who is thrown out today. Each change goes through the
 * same function the button calls and leaves the same audit line, marked as
 * coming from an assistant.
 *
 * Minecraft and ARK, the two games Polaris moderates. A Minecraft player is
 * named by their account name; an ARK survivor by their SteamID64, because a
 * survivor's name can be changed at will and two may share one.
 *
 * Deliberately not offered: op, kill and teleporting. The console tool reaches
 * them for whoever holds its grant. Items are `mcp-item-tools.ts`.
 *
 * Server-only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { isSteamId } from "./ark/access";
import type { AppHostTypes } from "@polaris/app-host";
import { MAX_TIMEOUT_MINUTES } from "./player-timeout";
import * as playerAccess from "./minecraft/player-access";
import { moderateArkPlayer } from "./ark/player-moderation";
import { readPlayerTimeouts } from "./player-timeout-service";
import { moderatePlayer } from "./minecraft/player-moderation";
import { listGameServerPresence, withNamesOnly } from "./games-service";
import { getServerRoster, runServerCommand } from "./minecraft/service";
import { liftTimeout, timeoutPlayer } from "./minecraft/timeout-service";
import { liftArkTimeout, timeoutArkPlayer } from "./ark/timeout-service";
import {
    attempt,
    gameOf,
    onlyFor,
    refuse,
    serverFor,
    serverId,
    MODERATED_GAMES
} from "./mcp-common";

type McpTool = AppHostTypes["McpTool"];

const { recordAudit } = host.auditService;

/** A Minecraft account name, the rule the Players tab holds a name to. */
const MINECRAFT_NAME = /^[A-Za-z0-9_]{1,16}$/;

const player = z
    .string()
    .trim()
    .min(1)
    .max(32)
    .describe(
        "The player: a Minecraft account name, or an ARK survivor's SteamID64 (as games_players lists them)."
    );

/** The player as the server's game names them, or the refusal saying how. */
function playerOn(game: string | null, name: string): string {
    if (game === "ark") {
        if (!isSteamId(name)) refuse("On an ARK server a player is their SteamID64, 17 digits.");
        return name.trim();
    }
    if (!MINECRAFT_NAME.test(name))
        refuse("A Minecraft name is 1 to 16 letters, digits or underscores.");
    return name;
}

/** The audit's action for a verb, as each panel writes it. */
function moderationAction(game: string | null, verb: string): string {
    return game === "ark" ? `games.ark.${verb}` : `minecraft.${verb}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const playersTool = () =>
    host.mcp.defineTool({
        name: "games_players",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Players on a game server",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Who is on a game server now, who is timed out and until when, and on Minecraft who may join (the access list and the whitelist), the operators and the bans. The ban list and the whitelist need the server up. Read-only.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.read");
            const game = gameOf(access);
            const [presence, timeouts] = await Promise.all([
                listGameServerPresence(access.ownerId, [], [input.serverId]).then(
                    (rows) => rows[0] ?? null
                ),
                readPlayerTimeouts(input.serverId).catch(() => [])
            ]);
            const online = presence ? withNamesOnly(presence).players : [];
            const minecraft =
                game === "minecraft"
                    ? await Promise.all([
                          playerAccess
                              .listPlayerAccess(access.ownerId, input.serverId)
                              .then((view) => playerAccess.forViewer(view, user))
                              .catch(() => null),
                          presence?.answering
                              ? getServerRoster(access.ownerId, input.serverId).catch(() => null)
                              : null
                      ])
                    : null;
            const list = minecraft?.[0] ?? null;
            const roster = minecraft?.[1] ?? null;
            const structured = {
                serverId: input.serverId,
                game,
                online,
                timeouts: timeouts.map((entry) => ({ player: entry.player, until: entry.until })),
                access: list
                    ? {
                          addressesChecked: list.bindAddresses && list.addressesAvailable,
                          rules: list.rules.map((rule) => ({
                              username: rule.username,
                              address: rule.address,
                              note: rule.note,
                              followsSignIns: rule.source === "session"
                          })),
                          linked: list.links.map((link) => ({
                              username: link.username,
                              account: link.name
                          })),
                          turnedAway: list.refusals.slice(0, 10)
                      }
                    : null,
                roster: roster
                    ? {
                          whitelistEnforced: roster.whitelistEnforced,
                          whitelist: roster.whitelist,
                          operators: roster.ops,
                          bans: roster.bans.map((ban) => ({ name: ban.name, reason: ban.reason }))
                      }
                    : null
            };
            const lines = [
                `${access.install.name}: ${online.length > 0 ? `on now: ${online.join(", ")}` : "nobody on now"}.`,
                ...(structured.timeouts.length > 0
                    ? [
                          `Timed out: ${structured.timeouts.map((entry) => `${entry.player} until ${entry.until}`).join(", ")}.`
                      ]
                    : []),
                ...(structured.access
                    ? [
                          structured.access.rules.length > 0
                              ? `May join: ${structured.access.rules.map((rule) => `${rule.username} from ${rule.address}`).join(", ")}.`
                              : "Nobody is on the access list.",
                          ...(structured.access.turnedAway.length > 0
                              ? [
                                    `Turned away lately: ${structured.access.turnedAway.map((one) => one.player).join(", ")}.`
                                ]
                              : [])
                      ]
                    : []),
                ...(structured.roster
                    ? [
                          `Whitelist ${structured.roster.whitelistEnforced ? "on" : "off"}${structured.roster.whitelist.length > 0 ? `: ${structured.roster.whitelist.join(", ")}` : ""}.`,
                          `Banned: ${structured.roster.bans.length > 0 ? structured.roster.bans.map((ban) => ban.name).join(", ") : "nobody"}.`
                      ]
                    : [])
            ];
            return { text: lines.join("\n"), structured };
        }
    });

// ---------------------------------------------------------------------------
// Moderating
// ---------------------------------------------------------------------------

const moderateInput = z.object({
    serverId,
    player,
    action: z
        .enum(["kick", "ban", "pardon", "whitelist-add", "whitelist-remove"])
        .describe(
            "kick: throw them off now. ban: keep them out for good. pardon: lift a ban (or a timeout's ban). whitelist-add / whitelist-remove: Minecraft only."
        ),
    reason: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Shown to the player kicked or banned. Minecraft only.")
});

const moderateTool = () =>
    host.mcp.defineTool({
        name: "games_player_moderate",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Kick, ban or whitelist a player",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Kick, ban or pardon a player on a Minecraft or ARK server, or put a Minecraft player on or off the whitelist, as the Players tab's buttons do. A ban keeps them out until somebody pardons it; for a while only, use games_player_timeout. Confirm the player and the action with the person first.",
        input: moderateInput,
        category: "games",
        scope: "gameservers.moderate",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.moderate");
            onlyFor(access, MODERATED_GAMES, "Moderating players");
            const game = gameOf(access);
            const name = playerOn(game, input.player);
            let output = "";
            if (game === "ark") {
                if (input.action === "whitelist-add" || input.action === "whitelist-remove")
                    refuse("ARK has no whitelist; who may join is its join password.");
                const verb = input.action === "pardon" ? "unban" : input.action;
                await attempt(() => moderateArkPlayer(access.ownerId, input.serverId, name, verb));
                await recordAudit({
                    actorId: user.id,
                    action: moderationAction(game, verb),
                    targetType: "installedApp",
                    targetId: input.serverId,
                    metadata: { steamId: name, via: "mcp" }
                });
            } else {
                output = await attempt(() =>
                    moderatePlayer(access.ownerId, input.serverId, {
                        action: input.action,
                        player: name,
                        reason: input.reason
                    })
                );
                await recordAudit({
                    actorId: user.id,
                    action: moderationAction(game, input.action),
                    targetType: "installedApp",
                    targetId: input.serverId,
                    metadata: { player: name, via: "mcp" }
                });
            }
            const said = output.trim();
            return {
                text: said || `Done: ${input.action} ${name} on ${access.install.name}.`,
                structured: {
                    serverId: input.serverId,
                    player: name,
                    action: input.action,
                    output: said
                }
            };
        }
    });

const timeoutInput = z.object({
    serverId,
    player,
    minutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MINUTES)
        .optional()
        .describe(
            `How long they are kept out, up to ${MAX_TIMEOUT_MINUTES} (a week). Leave out with lift.`
        ),
    lift: z.boolean().default(false).describe("True to end a timeout early and let them back in."),
    reason: z.string().trim().max(200).optional().describe("Shown to the player.")
});

const timeoutTool = () =>
    host.mcp.defineTool({
        name: "games_player_timeout",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Time a player out",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Ban a player from a Minecraft or ARK server for a number of minutes, which Polaris lifts by itself when it ends - or, with lift, end one early. Confirm with the person first.",
        input: timeoutInput,
        category: "games",
        scope: "gameservers.moderate",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.moderate");
            onlyFor(access, MODERATED_GAMES, "Timing players out");
            const game = gameOf(access);
            const name = playerOn(game, input.player);
            const who = game === "ark" ? { steamId: name } : { player: name };
            if (input.lift) {
                await attempt(() =>
                    game === "ark"
                        ? liftArkTimeout(access.ownerId, input.serverId, name)
                        : liftTimeout(access.ownerId, input.serverId, name)
                );
                await recordAudit({
                    actorId: user.id,
                    action: game === "ark" ? "games.ark.unban" : "minecraft.timeout-lift",
                    targetType: "installedApp",
                    targetId: input.serverId,
                    metadata: { ...who, via: "mcp" }
                });
                return {
                    text: `${name} may come back to ${access.install.name}.`,
                    structured: { serverId: input.serverId, player: name, until: null }
                };
            }
            const minutes = input.minutes ?? refuse("Say how many minutes, or lift one.");
            const entry = await attempt(() =>
                game === "ark"
                    ? timeoutArkPlayer(
                          access.ownerId,
                          input.serverId,
                          name,
                          minutes,
                          input.reason ?? ""
                      )
                    : timeoutPlayer(access.ownerId, input.serverId, name, minutes, input.reason)
            );
            await recordAudit({
                actorId: user.id,
                action: game === "ark" ? "games.ark.timeout" : "minecraft.timeout",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata:
                    game === "ark"
                        ? { ...who, minutes, until: entry.until, via: "mcp" }
                        : { ...who, minutes, via: "mcp" }
            });
            return {
                text: `${name} is kept out of ${access.install.name} until ${entry.until}.`,
                structured: { serverId: input.serverId, player: name, until: entry.until }
            };
        }
    });

const whitelistTool = () =>
    host.mcp.defineTool({
        name: "games_whitelist",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Turn a Minecraft whitelist on or off",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Turn a Minecraft server's whitelist on (only the players on it may join) or off (anybody may), as the Players tab's switch does. Needs the server up. games_player_moderate puts players on it.",
        input: z.object({
            serverId,
            enforced: z.boolean().describe("True: only whitelisted players may join.")
        }),
        category: "games",
        scope: "gameservers.moderate",
        readOnly: false,
        idempotent: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.moderate");
            onlyFor(access, ["minecraft"], "A whitelist");
            const output = await attempt(() =>
                runServerCommand(access.ownerId, input.serverId, [
                    "whitelist",
                    input.enforced ? "on" : "off"
                ])
            );
            await recordAudit({
                actorId: user.id,
                action: "minecraft.whitelist-enforce",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { enforced: String(input.enforced), via: "mcp" }
            });
            return {
                text: output.trim() || `Whitelist ${input.enforced ? "on" : "off"}.`,
                structured: { serverId: input.serverId, enforced: input.enforced }
            };
        }
    });

// ---------------------------------------------------------------------------
// Who may join
// ---------------------------------------------------------------------------

const accessInput = z.object({
    serverId,
    action: z
        .enum(["grant", "revoke"])
        .describe("grant: let them in. revoke: take them off the list, and off the server."),
    username: z.string().trim().min(1).max(16).describe("Their Minecraft account name."),
    address: z
        .string()
        .trim()
        .min(1)
        .max(43)
        .optional()
        .describe('Where they may connect from, for grant: one IP, a range (CIDR), or "any".'),
    note: z.string().trim().max(120).optional().describe("Who they are, for the list.")
});

const accessTool = () =>
    host.mcp.defineTool({
        name: "games_player_access",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Let a player in, or take them off the list",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Change who may ever join a Minecraft server, as its access list does: grant a username from an address (or any), or revoke one, which also throws them off if they are on. Confirm the name and the address with the person first.",
        input: accessInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.manage");
            onlyFor(access, ["minecraft"], "An access list");
            if (input.action === "revoke") {
                await attempt(() =>
                    playerAccess.revokePlayerAccess(access.ownerId, input.serverId, input.username)
                );
                await recordAudit({
                    actorId: user.id,
                    action: "minecraft.access-revoke",
                    targetType: "installedApp",
                    targetId: input.serverId,
                    metadata: { player: input.username, via: "mcp" }
                });
                return {
                    text: `${input.username} is off ${access.install.name}'s list.`,
                    structured: {
                        serverId: input.serverId,
                        username: input.username,
                        action: "revoke"
                    }
                };
            }
            const address = input.address ?? refuse('Say where they connect from, or "any".');
            await attempt(() =>
                playerAccess.grantPlayerAccess(access.ownerId, input.serverId, user.id, {
                    username: input.username,
                    address,
                    ...(input.note ? { note: input.note } : {})
                })
            );
            await recordAudit({
                actorId: user.id,
                action: "minecraft.access-grant",
                targetType: "installedApp",
                targetId: input.serverId,
                metadata: { player: input.username, address, via: "mcp" }
            });
            return {
                text: `${input.username} may join ${access.install.name} from ${address}.`,
                structured: {
                    serverId: input.serverId,
                    username: input.username,
                    address,
                    action: "grant"
                }
            };
        }
    });

export const playerTools: readonly (() => McpTool)[] = [
    playersTool,
    moderateTool,
    timeoutTool,
    whitelistTool,
    accessTool
];

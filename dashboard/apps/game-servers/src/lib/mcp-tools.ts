/**
 * Game servers, as tools a connected assistant can call.
 *
 * Offered through the `mcpTools` hook, so they exist only while Game servers
 * is installed. They act as the person the call is for, with that person's
 * standing on each server read by the same rule the server pages use
 * (`gameServerAccess`, the check inside `requireGameServer`), and do the work
 * through the same functions those pages' buttons call - a stop flushes the
 * world first, a console line is written to the audit before it runs. A
 * server somebody was only invited to watch is one their assistant can only
 * watch.
 *
 * Three scopes: seeing servers, who is on them and what a Minecraft player is
 * carrying (`gameservers.read`); kicking, banning and timing players out
 * (`gameservers.moderate`); and starting, stopping, restarting, the console,
 * worlds and who may join (`gameservers.manage`). The console also needs the
 * console grant on that server, as on its page.
 *
 * A Minecraft server's events are the Events screen's own buttons: the kinds
 * the catalog has, the events a server set up with what is on and how recent
 * ones went (`gameservers.read`), and starting one of those or calling off the
 * one on now (`gameservers.manage`). All of it asks for the console grant on
 * that server, as every one of the screen's actions does, and starts an event
 * through the same service call, so its preconditions refuse exactly as there.
 *
 * Players (`mcp-player-tools.ts`), what a Minecraft player carries
 * (`mcp-item-tools.ts`) and announcements, restarts and worlds
 * (`mcp-server-tools.ts`) are offered from their own modules, on the same
 * standing.
 *
 * Deliberately not offered: creating, deleting or reconfiguring a server, and
 * setting events up. Each is a page of its own.
 *
 * Server-only.
 */

import { z } from "zod";
import * as catalog from "./minecraft/events/catalog";
import { host } from "@polaris/app-host";
import { gameOfServer } from "@polaris/core";
import { statusOf } from "../screens/list";
import { slotLabel } from "./minecraft/inventory";
import { MAX_CONSOLE_LINE } from "./console-queue";
import type { AppHostTypes } from "@polaris/app-host";
import { gameCatalogs } from "../../messages";
import { itemTools } from "./mcp-item-tools";
import { playerTools } from "./mcp-player-tools";
import { serverTools } from "./mcp-server-tools";
import { actorFor, attempt, refuse, serverFor, serverId } from "./mcp-common";
import { restartServerNow, runConsoleCommand, setServerRunning } from "./games-operations";
import { listGameServerFacts, listGameServerPresence, withNamesOnly } from "./games-service";

type McpTool = AppHostTypes["McpTool"];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const serversTool = () =>
    host.mcp.defineTool({
        name: "games_servers",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "List game servers",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The game servers this account runs or was invited to: which game, whether each is meant to be up, and where players connect. games_server_status reads one live, with who is playing.",
        input: z.object({}),
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(_input, caller) {
            const user = await actorFor(caller);
            const granted = await host.appsInstallAccess.reachableInstallIds(user, "games.read");
            const servers = (await listGameServerFacts(user.id, granted)).map((server) => ({
                id: server.id,
                name: server.name,
                game: server.catalogName,
                running: server.running,
                address: server.address,
                slots: server.slots
            }));
            if (servers.length === 0) return { text: "No game servers.", structured: { servers } };
            return {
                text: servers
                    .map(
                        (server) =>
                            `${server.id}  ${server.name} (${server.game}): ${server.running ? "up" : "stopped"}${server.address ? ` at ${server.address}` : ""}`
                    )
                    .join("\n"),
                structured: { servers }
            };
        }
    });

const statusInput = z.object({ serverId });

const statusTool = () =>
    host.mcp.defineTool({
        name: "games_server_status",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Game server status",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "One game server as it is right now: online, starting, stopped or down, and the players on it. Asks the server itself, so it takes a moment.",
        input: statusInput,
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            const { access } = await serverFor(caller, input.serverId, "games.read");
            const [facts, presence] = await Promise.all([
                listGameServerFacts(access.ownerId, [], [input.serverId]).then(
                    (rows) => rows[0] ?? null
                ),
                listGameServerPresence(access.ownerId, [], [input.serverId]).then(
                    (rows) => rows[0] ?? null
                )
            ]);
            const live = presence ? withNamesOnly(presence) : null;
            const status = statusOf({ status: access.install.status, facts, live });
            const structured = {
                id: input.serverId,
                name: access.install.name,
                status,
                address: facts?.address ?? null,
                online: live?.online ?? 0,
                max: live?.max || facts?.slots || null,
                players: live?.players ?? [],
                message: live?.message ?? null
            };
            const playing = `${structured.online}${structured.max ? `/${structured.max}` : ""} playing`;
            return {
                text: `${structured.name}: ${status}${structured.address ? ` at ${structured.address}` : ""}. ${playing}${structured.players.length > 0 ? `: ${structured.players.join(", ")}` : ""}.`,
                structured
            };
        }
    });

/** The bag reader, loaded when the tool runs: it reaches the server's container
 *  and the database, which listing the tools has no need of. */
const inventoryService = () => import("./minecraft/inventory-service");

const inventoryInput = z.object({
    serverId,
    player: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_]{1,16}$/, "A Minecraft account name")
        .describe("The player's Minecraft name, as games_server_status lists them.")
});

/** What an offline player, an old server or a silent one is said as. */
const INVENTORY_REFUSALS = {
    offline:
        "That player is not on the server, and Polaris has not kept a copy of what they carry yet.",
    unsupported: "This server's version has no command to read what a player carries.",
    unanswered: "The server did not answer with an inventory"
} as const;

const inventoryTool = () =>
    host.mcp.defineTool({
        name: "games_player_inventory",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "A Minecraft player's inventory",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "What one player is carrying on a Minecraft Java server - hotbar, bag, armour and offhand, each stack with its slot, item, count and its components (enchantments, damage, name). Live while they are on; when they are not, the last copy Polaris kept, with when it was taken. The same reading as the player's page. Read-only.",
        input: inventoryInput,
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            const { access } = await serverFor(caller, input.serverId, "games.read");
            if (gameOfServer(access.install.catalogId)?.id !== "minecraft")
                refuse("Only a Minecraft server has inventories to read.");
            const { readPlayerInventory } = await inventoryService();
            const read = await attempt(() =>
                readPlayerInventory(access.ownerId, access.install.id, input.player)
            );
            if ("refusal" in read) {
                const refusal = read.refusal;
                refuse(
                    refusal.reason === "unanswered" && refusal.said
                        ? `${INVENTORY_REFUSALS.unanswered}: ${refusal.said}`
                        : INVENTORY_REFUSALS[refusal.reason]
                );
            }
            const { inventory } = read;
            const items = inventory.items.map((item) => ({
                slot: item.slot,
                where: slotLabel(item.slot),
                id: item.id,
                count: item.count,
                components: item.data?.snbt ?? null
            }));
            const structured = {
                serverId: input.serverId,
                player: input.player,
                live: inventory.live,
                takenAt: inventory.takenAt,
                items,
                unreadable: inventory.unreadable ?? 0
            };
            const heading = inventory.live
                ? `${input.player} is carrying, live:`
                : `${input.player} is not on; the last copy Polaris kept, taken ${inventory.takenAt}:`;
            const lines =
                items.length > 0
                    ? items.map(
                          (item) =>
                              `  ${item.where}: ${item.id} x${item.count}${item.components ? ` ${item.components}` : ""}`
                      )
                    : ["  nothing"];
            const missing =
                structured.unreadable > 0
                    ? [`${structured.unreadable} more stack(s) could not be read whole.`]
                    : [];
            return { text: [heading, ...lines, ...missing].join("\n"), structured };
        }
    });

// ---------------------------------------------------------------------------
// Managing
// ---------------------------------------------------------------------------

const powerInput = z.object({
    serverId,
    action: z
        .enum(["start", "stop", "restart"])
        .describe("Start it, stop it (the world is saved first), or save and restart it.")
});

const powerTool = () =>
    host.mcp.defineTool({
        name: "games_server_power",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Start, stop or restart a game server",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Start, stop or restart a game server this account manages. Stopping or restarting disconnects everybody playing: check games_server_status and confirm with the person first.",
        input: powerInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.manage");
            if (input.action === "restart") await attempt(() => restartServerNow(user, access));
            else await attempt(() => setServerRunning(user, access, input.action === "start"));
            const done = { start: "Starting", stop: "Stopped", restart: "Restarting" }[
                input.action
            ];
            return {
                text: `${done}: ${access.install.name}.`,
                structured: { serverId: input.serverId, action: input.action }
            };
        }
    });

const consoleInput = z.object({
    serverId,
    command: z
        .string()
        .trim()
        .min(1)
        .max(MAX_CONSOLE_LINE)
        .regex(/^[^\r\n\0]*$/, "One line")
        .describe(
            "One console command, as typed in the server's console (say, list, time set day)."
        )
});

const consoleTool = () =>
    host.mcp.defineTool({
        name: "games_console",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Run a console command",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Run one command on a game server's console and read what it answered. The console can do anything the server can, op included: run only what the person asked for.",
        input: consoleInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.console");
            const output = await attempt(() => runConsoleCommand(user, access, input.command));
            return {
                text: output || "(no output)",
                structured: { serverId: input.serverId, output }
            };
        }
    });

// ---------------------------------------------------------------------------
// Minecraft events
// ---------------------------------------------------------------------------

/** The events service, loaded when a tool runs: it reaches the server's
 *  container, which listing the tools has no need of. */
const eventsService = () => import("./minecraft/events/events-service");

/** A kind's words in the caller's language. Read from the catalog directly: a
 *  kind's id has a dash, which a carried message key cannot. */
async function kindWords(kind: catalog.EventKind) {
    const locale = await host.i18nRequest.getLocale();
    return {
        name: gameCatalogs.translate(locale, `minecraft.events.kinds.${kind}.label`),
        summary: gameCatalogs.translate(locale, `minecraft.events.kinds.${kind}.summary`)
    };
}

/**
 * What one setting of an event can be, read off the catalog's own schema: the
 * choices of a list, the bounds of a number, or the type. Enough for a model
 * to say what an event does and to tell a person what to change on the
 * screen; nothing is set from here.
 */
function describeOption(schema: z.ZodTypeAny): unknown {
    if (schema instanceof z.ZodDefault) return describeOption(schema._def.innerType);
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
        return describeOption(schema.unwrap());
    if (schema instanceof z.ZodEffects) return describeOption(schema.innerType());
    if (schema instanceof z.ZodEnum) return { oneOf: [...schema.options] };
    if (schema instanceof z.ZodLiteral) return { oneOf: [schema.value] };
    if (schema instanceof z.ZodNumber)
        return { type: "number", min: schema.minValue, max: schema.maxValue };
    if (schema instanceof z.ZodBoolean) return { type: "boolean" };
    if (schema instanceof z.ZodString) return { type: "text" };
    if (schema instanceof z.ZodArray) return { listOf: describeOption(schema.element) };
    if (schema instanceof z.ZodDiscriminatedUnion) return { oneOf: [...schema.optionsMap.keys()] };
    if (schema instanceof z.ZodObject)
        return Object.fromEntries(
            Object.entries(schema.shape as z.ZodRawShape).map(([key, field]) => [
                key,
                describeOption(field)
            ])
        );
    return { type: "other" };
}

const kindsInput = z.object({
    query: z
        .string()
        .trim()
        .max(100)
        .default("")
        .describe("Only kinds whose id, name or summary contains this.")
});

const eventKindsTool = () =>
    host.mcp.defineTool({
        name: "games_event_kinds",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Minecraft event kinds",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Every kind of event Polaris can run on a Minecraft Java server - mining rush, trivia, boss fights, parkour and the rest - with what each is, how long it runs by default, and the settings it takes. Events are set up on a server's Events screen; games_events lists the ones a server has. Read-only.",
        input: kindsInput,
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            await actorFor(caller);
            const wanted = input.query.toLowerCase();
            const kinds = (
                await Promise.all(
                    catalog.OFFERED_KINDS.map(async (kind) => {
                        const words = await kindWords(kind);
                        const fresh = catalog.newPreset(kind, kind);
                        const schema = catalog.optionsSchemas[kind] as z.ZodTypeAny;
                        return {
                            kind,
                            name: words.name,
                            summary: words.summary,
                            competitive: catalog.KIND_INFO[kind].competitive,
                            minutes: catalog.DEFAULT_MINUTES[kind],
                            defaults: fresh.options as Record<string, unknown>,
                            options: describeOption(schema) as Record<string, unknown>
                        };
                    })
                )
            ).filter(
                (entry) =>
                    !wanted ||
                    [entry.kind, entry.name, entry.summary].some((value) =>
                        value.toLowerCase().includes(wanted)
                    )
            );
            if (kinds.length === 0) return { text: "No kinds match.", structured: { kinds } };
            return {
                text: kinds
                    .map(
                        (entry) =>
                            `${entry.kind}  ${entry.name} (${entry.minutes} min${entry.competitive ? ", ranked" : ""}): ${entry.summary}`
                    )
                    .join("\n"),
                structured: { kinds }
            };
        }
    });

const eventsTool = () =>
    host.mcp.defineTool({
        name: "games_events",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "A Minecraft server's events",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The events one Minecraft server has set up, the one on now with its standings, and how the recent ones went (winners and scores). Needs the console on that server. Read-only; games_event_start starts one.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.read",
        readOnly: true,
        async run(input, caller) {
            const { access } = await serverFor(caller, input.serverId, "games.console");
            const events = await eventsService();
            const view = await attempt(() => events.eventsView(access.install.id));
            const saved = view.config.presets.map((preset) => ({
                id: preset.id,
                name: preset.name,
                kind: preset.kind,
                enabled: preset.enabled,
                minutes: preset.minutes,
                options: preset.options as Record<string, unknown>,
                // Why this server cannot play it, when its version says so.
                cannotRun: catalog.incompatibility(preset, view.version)
            }));
            const running = view.run
                ? {
                      eventId: view.run.presetId,
                      name: view.run.name,
                      kind: view.run.kind,
                      phase: view.run.phase,
                      trigger: view.run.trigger,
                      startsAt: new Date(view.run.startsAt).toISOString(),
                      endsAt: new Date(view.run.endsAt).toISOString(),
                      cancelling: view.run.cancelling,
                      standings: view.run.standings
                  }
                : null;
            const recent = view.history.slice(0, 10).map((entry) => ({
                eventId: entry.presetId,
                name: entry.name,
                kind: entry.kind,
                trigger: entry.trigger,
                outcome: entry.outcome,
                note: entry.note,
                startedAt: new Date(entry.startedAt).toISOString(),
                endedAt: new Date(entry.endedAt).toISOString(),
                participants: entry.participants,
                podium: entry.podium
            }));
            const structured = {
                serverId: input.serverId,
                events: saved,
                running,
                recent,
                players: view.players,
                version: view.version,
                refusal: view.refusal
            };
            const lines = [
                ...(view.refusal ? [view.refusal] : []),
                running
                    ? `On now: ${running.name} (${running.kind}), ${running.phase}${running.cancelling ? ", being called off" : ""}, ends ${running.endsAt}.${running.standings.length > 0 ? ` Standings: ${running.standings.map((one) => `${one.name} ${one.score}`).join(", ")}.` : ""}`
                    : "No event on now.",
                "Set up:",
                ...(saved.length > 0
                    ? saved.map(
                          (preset) =>
                              `  ${preset.id}  ${preset.name} (${preset.kind}, ${preset.minutes} min)${preset.enabled ? "" : " - switched off"}${preset.cannotRun ? ` - needs ${preset.cannotRun.needs}` : ""}`
                      )
                    : ["  none"]),
                ...(recent.length > 0
                    ? [
                          "Recent:",
                          ...recent.map(
                              (entry) =>
                                  `  ${entry.startedAt}  ${entry.name}: ${entry.outcome}. ${entry.note}`
                          )
                      ]
                    : [])
            ];
            return { text: lines.join("\n"), structured };
        }
    });

const startInput = z.object({
    serverId,
    eventId: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("The event, as games_events listed it among the ones the server set up.")
});

const eventStartTool = () =>
    host.mcp.defineTool({
        name: "games_event_start",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Start a Minecraft event",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Start one of a Minecraft server's events now, as its Run button does: a countdown is announced to everybody on the server, then the event runs and hands out its prizes. Refused while another is on, with nobody on, or when the server cannot play it. Confirm with the person first.",
        input: startInput,
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.console");
            const events = await eventsService();
            const run = await attempt(() =>
                events.startEvent({
                    ownerId: access.ownerId,
                    installedAppId: access.install.id,
                    presetId: input.eventId,
                    trigger: "manual",
                    startedBy: user.id
                })
            );
            await host.auditService.recordAudit({
                actorId: user.id,
                action: "games.events.start",
                targetType: "installedApp",
                targetId: access.install.id,
                metadata: { event: run.preset.name, kind: run.preset.kind, via: "mcp" }
            });
            const startsAt = new Date(run.startsAt).toISOString();
            return {
                text: `${run.preset.name} starts at ${startsAt} on ${access.install.name}, after its countdown.`,
                structured: {
                    serverId: input.serverId,
                    eventId: run.preset.id,
                    name: run.preset.name,
                    kind: run.preset.kind,
                    startsAt,
                    endsAt: new Date(run.endsAt).toISOString()
                }
            };
        }
    });

const eventCancelTool = () =>
    host.mcp.defineTool({
        name: "games_event_cancel",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Call off a Minecraft event",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Call off the event on now on a Minecraft server, as its Cancel button does. It is taken down on its next tick and its arena, if it built one, is cleared; nobody is ranked.",
        input: z.object({ serverId }),
        category: "games",
        scope: "gameservers.manage",
        readOnly: false,
        async run(input, caller) {
            const { user, access } = await serverFor(caller, input.serverId, "games.console");
            const events = await eventsService();
            await attempt(() => events.cancelEvent(access.ownerId, access.install.id));
            await host.auditService.recordAudit({
                actorId: user.id,
                action: "games.events.cancel",
                targetType: "installedApp",
                targetId: access.install.id,
                metadata: { via: "mcp" }
            });
            return {
                text: `Calling off the event on ${access.install.name}.`,
                structured: { serverId: input.serverId }
            };
        }
    });

/** Built when the app is first asked for its tools, not when this module
 *  loads: `defineTool` is the host's, and a module of this app can be loaded
 *  before the dashboard has provided it (test/home/cold-start). */
let built: readonly McpTool[] | undefined;

export function gameMcpTools(): readonly McpTool[] {
    built ??= [
        serversTool,
        statusTool,
        inventoryTool,
        powerTool,
        consoleTool,
        eventKindsTool,
        eventsTool,
        eventStartTool,
        eventCancelTool,
        ...playerTools,
        ...itemTools,
        ...serverTools
    ].map((tool) => tool());
    return built;
}

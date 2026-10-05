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
 * Two scopes: seeing servers and who is on them (`gameservers.read`), and
 * starting, stopping, restarting and the console (`gameservers.manage`). The
 * console also needs the console grant on that server, as on its page.
 *
 * Deliberately not offered: creating, deleting or reconfiguring a server, and
 * moderating players. Each is a page of its own.
 *
 * Server-only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { statusOf } from "../screens/list";
import { MAX_CONSOLE_LINE } from "./console-queue";
import type { AppHostTypes } from "@polaris/app-host";
import { gameMessageIn, readGameMessage } from "./game-message";
import { restartServerNow, runConsoleCommand, setServerRunning } from "./games-operations";
import { listGameServerFacts, listGameServerPresence, withNamesOnly } from "./games-service";

type McpTool = AppHostTypes["McpTool"];
type McpCaller = AppHostTypes["McpCaller"];

/** A refusal the model reads as written. A class from the host, so it is
 *  only reached for once a call is running. */
function refuse(message: string): never {
    throw new host.mcp.McpRefusal(message);
}

/**
 * Run the app's own work. What it throws for the person to read carries one
 * of the app's message keys, and reaches the model in the person's language;
 * anything else is the inside of a container and goes to the log.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof Error && readGameMessage(caught.message))
            refuse(gameMessageIn(await host.i18nRequest.getLocale(), caught.message));
        throw caught;
    }
}

async function actorFor(caller: McpCaller) {
    const user = await host.mcp.actingUser(caller.userId);
    if (!user) refuse("This account cannot use Game servers.");
    return user;
}

/** The caller's standing on one server, or the refusal a page would give. */
async function serverFor(
    caller: McpCaller,
    serverId: string,
    permission: "games.read" | "games.manage" | "games.console"
) {
    const user = await actorFor(caller);
    const access = await host.appsInstallAccess.gameServerAccess(user, serverId, permission);
    if (!access)
        refuse(
            permission === "games.read"
                ? "There is no game server with that id that this account can see."
                : "This account cannot do that on that game server."
        );
    return { user, access };
}

const serverId = z.string().uuid().describe("The server's id, as games_servers returned it.");

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

/** Built when the app is first asked for its tools, not when this module
 *  loads: `defineTool` is the host's, and a module of this app can be loaded
 *  before the dashboard has provided it (test/home/cold-start). */
let built: readonly McpTool[] | undefined;

export function gameMcpTools(): readonly McpTool[] {
    built ??= [serversTool, statusTool, powerTool, consoleTool].map((tool) => tool());
    return built;
}

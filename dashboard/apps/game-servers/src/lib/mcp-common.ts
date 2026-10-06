/**
 * What every Game servers MCP tool stands on: who is calling, their standing
 * on one server by the rule its pages read (`gameServerAccess`, the check
 * inside `requireGameServer`), and how the app's own refusals reach the model.
 *
 * Server-only.
 */

import { z } from "zod";
import { gameOfServer } from "@polaris/core";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { gameMessageIn, readGameMessage } from "./game-message";

type McpCaller = AppHostTypes["McpCaller"];

/** A refusal the model reads as written. A class from the host, so it is
 *  only reached for once a call is running. */
export function refuse(message: string): never {
    throw new host.mcp.McpRefusal(message);
}

/**
 * Run the app's own work. What it throws for the person to read carries one
 * of the app's message keys, and reaches the model in the person's language;
 * anything else is the inside of a container and goes to the log.
 */
export async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof Error && readGameMessage(caught.message))
            refuse(gameMessageIn(await host.i18nRequest.getLocale(), caught.message));
        throw caught;
    }
}

export async function actorFor(caller: McpCaller) {
    const user = await host.mcp.actingUser(caller.userId);
    if (!user) refuse("This account cannot use Game servers.");
    return user;
}

export type ServerPermission = "games.read" | "games.moderate" | "games.manage" | "games.console";

/** The caller's standing on one server, or the refusal a page would give. */
export async function serverFor(caller: McpCaller, serverId: string, permission: ServerPermission) {
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

/** The games whose players the moderation and timeout tools reach. */
export const MODERATED_GAMES: readonly string[] = ["minecraft", "ark"];

/** The game a server runs, by its catalog id. */
export function gameOf(access: { readonly install: { readonly catalogId: string } }) {
    return gameOfServer(access.install.catalogId)?.id ?? null;
}

/** Refuse a tool on a server of a game it does not reach. */
export function onlyFor(
    access: { readonly install: { readonly catalogId: string; readonly name: string } },
    games: readonly string[],
    what: string
): void {
    const game = gameOf(access);
    if (!game || !games.includes(game))
        refuse(`${what} is not something Polaris can do on ${access.install.name}'s game.`);
}

export const serverId = z
    .string()
    .uuid()
    .describe("The server's id, as games_servers returned it.");

/**
 * What every Calendar tool shares: how it refuses, how Calendar's own
 * refusals reach the model, and who the call acts for.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { CalendarRefusal } from "./errors";
import { readerView } from "./upcoming";
import type { AppHostTypes } from "@polaris/app-host";

type McpCaller = AppHostTypes["McpCaller"];

/** A refusal the model reads as written. A class from the host, so it is
 *  only reached for once a call is running. */
export function refuse(message: string): never {
    throw new host.mcp.McpRefusal(message);
}

/** Run Calendar's own work, turning its refusals - written for the person,
 *  naming nothing internal - into ones the model reads. */
export async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof CalendarRefusal) refuse(caught.message);
        throw caught;
    }
}

/** The person a call acts for, with the zone they read their calendar in. */
export async function readerFor(caller: McpCaller) {
    const acting = await host.mcp.actingUser(caller.userId);
    const reader = acting ? await readerView(caller.userId) : null;
    if (!acting || !reader) refuse("This account cannot use the Calendar.");
    return { ...reader, user: acting };
}

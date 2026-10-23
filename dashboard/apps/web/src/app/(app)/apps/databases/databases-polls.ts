/**
 * What the Databases screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as databasesActionsModule from "@/app/(app)/apps/databases/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const engineOptions = (signal?: AbortSignal) =>
    readPoll<Answer<typeof databasesActionsModule.engineOptionsAction>>(
        "/api/databases/engines",
        {},
        signal
    );

export const managedDatabases = (signal?: AbortSignal) =>
    readPoll<Answer<typeof databasesActionsModule.listManagedAction>>(
        "/api/databases/managed",
        {},
        signal
    );

export const tunnelServers = (signal?: AbortSignal) =>
    readPoll<Answer<typeof databasesActionsModule.listTunnelServersAction>>(
        "/api/databases/tunnel-servers",
        {},
        signal
    );

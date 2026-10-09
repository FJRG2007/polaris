/**
 * What the frame around every screen asks for, answered once for all scenes:
 * who is online, what people look like, whether mail arrived.
 */

import { TEAM, VIEWER } from "./people";
import type { ActionFixture, ApiFixture, SceneContext } from "../runtime/scene";

/** Online, away, or offline: enough variety for the dots to read as real. */
const PRESENCE: Record<string, "online" | "idle" | "offline"> = {
    [VIEWER.id]: "online",
    [TEAM.ana.id]: "online",
    [TEAM.sam.id]: "offline",
    [TEAM.lena.id]: "idle",
    [TEAM.kenji.id]: "online",
    [TEAM.priya.id]: "online"
};

export function chromeActions(): Record<string, ActionFixture> {
    return {
        presenceNowAction: () => ({
            held: { choice: "online", until: null },
            status: { text: "", until: null }
        })
    };
}

export function chromeApi(ctx: SceneContext): Record<string, ApiFixture> {
    return {
        "POST /api/presence": ({ body }) => {
            const ids = ((body as { ids?: string[] } | null)?.ids ?? []).filter((one) => one in PRESENCE);
            return {
                people: Object.fromEntries(
                    ids.map((one) => [one, { status: PRESENCE[one], note: "", inCall: null, activity: [] }])
                )
            };
        },
        "POST /api/profile/styles": () => ({
            people: {},
            names: {},
            nicknames: {},
            cleared: [],
            at: new Date(ctx.now).toISOString()
        }),
        "GET /api/mail/arrivals": () => ({ cursor: new Date(ctx.now).toISOString(), named: [], more: 0 })
    };
}

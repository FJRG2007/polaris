/**
 * What the frame around every screen asks for, answered once for all scenes:
 * who is online, what people look like, whether mail arrived.
 */

import { CREW, TEAM, VIEWER } from "./people";
import { NO_PROFILE_STYLE, type ProfileStyle } from "@polaris/core";
import type { ActionFixture, ApiFixture, SceneContext } from "../runtime/scene";

/** Online, away, or offline: enough variety for the dots to read as real. */
const PRESENCE: Record<string, "online" | "idle" | "offline"> = {
    [VIEWER.id]: "online",
    [TEAM.ana.id]: "online",
    [TEAM.sam.id]: "offline",
    [TEAM.lena.id]: "idle",
    [TEAM.kenji.id]: "online",
    [TEAM.priya.id]: "online",
    [CREW.mateo.id]: "online",
    [CREW.grace.id]: "online",
    [CREW.omar.id]: "idle",
    [CREW.yuki.id]: "online"
};

/** What some of them chose their profile to look like: the decorations, plates
 *  and name colours Polaris ships, the way a real team mixes them. */
const STYLES: Record<string, Partial<ProfileStyle>> = {
    [VIEWER.id]: { decoration: "aurora" },
    [TEAM.ana.id]: { decoration: "cat", nameplate: "rose", nameStyle: "rose" },
    [TEAM.kenji.id]: { decoration: "headphones", nameStyle: "tide" },
    [TEAM.priya.id]: { decoration: "flowers" },
    [CREW.grace.id]: { decoration: "crown", nameStyle: "gold" },
    [CREW.yuki.id]: { decoration: "orbit" }
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
            const ids = ((body as { ids?: string[] } | null)?.ids ?? []).filter(
                (one) => one in PRESENCE
            );
            return {
                people: Object.fromEntries(
                    ids.map((one) => [
                        one,
                        { status: PRESENCE[one], note: "", inCall: null, activity: [] }
                    ])
                )
            };
        },
        "POST /api/profile/styles": ({ body }) => ({
            people: Object.fromEntries(
                ((body as { ids?: string[] } | null)?.ids ?? [])
                    .filter((one) => one in STYLES)
                    .map((one) => [one, { ...NO_PROFILE_STYLE, ...STYLES[one] }])
            ),
            names: {},
            nicknames: {},
            cleared: [],
            at: new Date(ctx.now).toISOString()
        }),
        // Everybody here may open everybody's photo: they share a space.
        "POST /api/avatar/access": ({ body }) => ({
            allowed: (body as { ids?: string[] } | null)?.ids ?? []
        }),
        "GET /api/mail/arrivals": () => ({
            cursor: new Date(ctx.now).toISOString(),
            named: [],
            more: 0
        })
    };
}

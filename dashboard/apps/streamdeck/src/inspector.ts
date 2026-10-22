/**
 * What the settings screen is told, and what it may ask.
 *
 * The screen never sees the key: it is told whether the deck is connected,
 * to which Polaris and as whom, how a connect it started is going, and the
 * catalogue entries the action it belongs to can be set to.
 */

import { z } from "zod";
import { hub } from "./hub";
import { updateFor } from "./update";
import streamDeck from "@elgato/streamdeck";
import type { DeckAction } from "./polaris";

/** What the screen may send. Anything else is ignored. */
const messageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("hello") }),
    z.object({ type: z.literal("connect"), address: z.string().max(300) }),
    z.object({ type: z.literal("cancel") }),
    z.object({ type: z.literal("disconnect") }),
    z.object({ type: z.literal("refresh") })
]);

/**
 * Which catalogue entries an action of the plugin can be set to. The general
 * key and dial take everything of their kind; the call, soundboard and Places
 * actions take only their own, so their pickers are short.
 */
export type Surface = "key" | "dial" | "call" | "sound" | "places" | "places-dial";

const PLUGIN_UUID = "io.github.fjrg2007.polaris";

const SURFACES: Readonly<Record<string, Surface>> = {
    [`${PLUGIN_UUID}.key`]: "key",
    [`${PLUGIN_UUID}.dial`]: "dial",
    [`${PLUGIN_UUID}.call`]: "call",
    [`${PLUGIN_UUID}.sound`]: "sound",
    [`${PLUGIN_UUID}.places`]: "places",
    [`${PLUGIN_UUID}.places-dial`]: "places-dial"
};

/** The surface a manifest action id stands for, or null for one that has no
 *  catalogue (the timer). */
export function surfaceOf(manifestId: string): Surface | null {
    return SURFACES[manifestId] ?? null;
}

export function offered(catalogue: readonly DeckAction[], surface: Surface): DeckAction[] {
    return catalogue.filter((entry) => {
        const dial = entry.kind === "dial";
        switch (surface) {
            case "key":
                return !dial;
            case "dial":
                return dial;
            case "call":
                return entry.area === "call" && entry.id !== "call.sound";
            case "sound":
                return entry.id === "call.sound";
            case "places":
                return entry.area === "places" && !dial;
            case "places-dial":
                return entry.area === "places" && dial;
        }
    });
}

/** Tell the open settings screen where things stand. */
export async function tellInspector(surface: Surface): Promise<void> {
    await streamDeck.ui.sendToPropertyInspector({
        type: "status",
        link: hub.link,
        address: hub.credentials?.address ?? null,
        account: hub.credentials?.account ?? null,
        connecting: hub.connecting,
        update: updateFor(hub.latest, hub.client.version, hub.credentials?.address ?? null),
        catalogue: offered(hub.catalogue, surface) as never
    });
}

/** Act on what the settings screen sent. */
export async function fromInspector(payload: unknown, surface: Surface): Promise<void> {
    const parsed = messageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "connect") void hub.connect(message.address);
    else if (message.type === "cancel") hub.cancelConnect();
    else if (message.type === "disconnect") await hub.disconnect();
    else if (message.type === "refresh") await hub.refreshCatalogue(true);
    await tellInspector(surface);
}

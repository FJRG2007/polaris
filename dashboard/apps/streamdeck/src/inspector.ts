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
import { canUpdateNow, updateNow, updateState, type UpdateRun } from "./self-update";
import { offered, type Surface } from "./surfaces";

/** What the screen may send. Anything else is ignored. */
const messageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("hello") }),
    z.object({ type: z.literal("connect"), address: z.string().max(300) }),
    z.object({ type: z.literal("cancel") }),
    z.object({ type: z.literal("disconnect") }),
    z.object({ type: z.literal("refresh") }),
    z.object({ type: z.literal("updateNow") })
]);

/** The "Update now" this plugin started: the job closes the app when it swaps
 *  the plugin, so a copy still running long after it did not get updated. */
let updateRun: UpdateRun = null;

/** Tell the open settings screen where things stand. */
export async function tellInspector(surface: Surface): Promise<void> {
    await streamDeck.ui.sendToPropertyInspector({
        type: "status",
        link: hub.link,
        address: hub.credentials?.address ?? null,
        account: hub.credentials?.account ?? null,
        connecting: hub.connecting,
        update: withUpdateNow(updateFor(hub.latest, hub.client.version, hub.credentials?.address ?? null)),
        catalogue: offered(hub.catalogue, surface) as never,
        locked: hub.locked as never
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
    else if (message.type === "updateNow") updateRun = { ok: await updateNow(), at: Date.now() };
    await tellInspector(surface);
}

/** The notice, told whether this copy can update itself now and how that went. */
function withUpdateNow(update: { version: string; url: string } | null) {
    if (!update) return null;
    return { ...update, now: canUpdateNow(), updating: updateState(updateRun) };
}

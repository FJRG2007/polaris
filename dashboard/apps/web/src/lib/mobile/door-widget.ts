/**
 * Doors on a phone's home screen.
 *
 * The widget opens a door through the Places tool an assistant or a Stream
 * Deck would call for it (`places_device_control`, action `open`), so it
 * reaches exactly the doors its owner does: a door that was not lent to them,
 * or one set to be watched rather than operated, is refused by the tool as it
 * is on the screen. Nothing here reads or writes a device itself.
 *
 * The caller is the signed-in session, with only the Places scopes its owner
 * holds; the routes add the phone's own signature on top (`device-proof`).
 *
 * Server-only.
 */

import { z } from "zod";
import type { McpCaller } from "@/lib/mcp/protocol";
import { callSessionTool, sessionCaller } from "@/lib/mcp/session-call";

const WIDGET_SCOPES = ["places.read", "places.control"] as const;

export interface DoorView {
    readonly id: string;
    readonly name: string;
    readonly state: string | null;
    readonly online: boolean;
}

export type DoorOutcome =
    | { readonly ok: true; readonly confirmed: boolean }
    | { readonly ok: false; readonly reason: "missing" | "throttled" | "refused"; readonly message: string | null };

const deviceRows = z.object({
    devices: z.array(
        z
            .object({
                id: z.string(),
                name: z.string(),
                state: z.string().nullish(),
                online: z.boolean(),
                actions: z.array(z.string())
            })
            .passthrough()
    )
});

/** The session as an MCP caller holding only the Places scopes its owner holds. */
export function phoneCaller(user: { readonly id: string; readonly isAdmin: boolean }): Promise<McpCaller> {
    return sessionCaller(user, WIDGET_SCOPES);
}

function call(caller: McpCaller, name: string, input: unknown) {
    return callSessionTool(caller, name, input, "phone");
}

/** The doors this person can open, for the widget's picker and its state. Null when Places is not theirs. */
export async function doorsFor(caller: McpCaller, deviceId?: string): Promise<DoorView[] | null> {
    const answer = await call(caller, "places_devices", deviceId ? { deviceId } : {});
    if (!answer.ok) return answer.reason === "missing" ? null : [];
    const parsed = deviceRows.safeParse(answer.structured);
    if (!parsed.success) return [];
    return parsed.data.devices
        .filter((device) => device.actions.includes("open"))
        .map((device) => ({ id: device.id, name: device.name, state: device.state ?? null, online: device.online }));
}

/** Open one door. */
export async function openDoor(caller: McpCaller, deviceId: string): Promise<DoorOutcome> {
    const answer = await call(caller, "places_device_control", { deviceId, action: "open" });
    if (!answer.ok) return answer;
    const confirmed = z.object({ confirmed: z.boolean() }).safeParse(answer.structured);
    return { ok: true, confirmed: confirmed.success && confirmed.data.confirmed };
}

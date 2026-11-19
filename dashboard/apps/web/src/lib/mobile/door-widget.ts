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
import { mcpTools } from "@/lib/mcp/catalog";
import { scopesAvailableTo } from "@polaris/auth";
import { MCP_ONLY_SCOPES, type McpScope } from "@/lib/mcp/scope-table";
import { auditToolChange, spendToolBudget } from "@/lib/mcp/call-guard";
import { callerMayUse, McpRefusal, type McpCaller } from "@/lib/mcp/protocol";

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
export async function phoneCaller(user: { readonly id: string; readonly isAdmin: boolean }): Promise<McpCaller> {
    const held = new Set<string>(await scopesAvailableTo(user.id, user.isAdmin));
    const scopes = WIDGET_SCOPES.filter((scope) => held.has(MCP_ONLY_SCOPES[scope].requires));
    return { userId: user.id, isAdmin: user.isAdmin, keyId: null, scopes: scopes as McpScope[] };
}

async function call(caller: McpCaller, name: string, input: unknown) {
    const tool = (await mcpTools()).find((candidate) => candidate.name === name);
    if (!tool || !callerMayUse(tool, caller)) return { ok: false as const, reason: "missing" as const, message: null };
    const args = tool.input.safeParse(input);
    if (!args.success) return { ok: false as const, reason: "refused" as const, message: null };
    if (!tool.readOnly && (await spendToolBudget(tool, caller)) !== null) {
        return { ok: false as const, reason: "throttled" as const, message: null };
    }
    try {
        const structured = (await tool.run(args.data as never, caller)).structured ?? null;
        await auditToolChange(tool, caller, "phone");
        return { ok: true as const, structured };
    } catch (caught) {
        if (caught instanceof McpRefusal) return { ok: false as const, reason: "refused" as const, message: caught.message };
        console.error(`phone widget: ${name} failed`, caught);
        return { ok: false as const, reason: "refused" as const, message: null };
    }
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

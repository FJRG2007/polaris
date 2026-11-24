/**
 * What passes between the app and a running device add-on. The add-on runs in
 * its own process (an Electron utility process) and this is the only way it
 * reaches the app: every message it sends is checked here, and a call is only
 * answered when the add-on was granted the permission the method needs.
 *
 * The permissions gate what the APP does for an add-on. They do not sandbox the
 * add-on's own native code, which runs with the user's rights - that is why only
 * packages from the signed Polaris catalog are ever installed.
 */

import { z } from "zod";
import { ADDON_ACTIONS, type AddonPermission, type AddonSettingValue, type UsbDevice } from "@polaris/core/device-addons";

/** The methods an add-on may call, and the permission each one needs (null: none). */
export const ADDON_METHODS = {
    /** Run one of the app's own actions: call mute, deafen, push to talk... */
    "polaris.action": "polaris-actions",
    /** The calls and media playing now, for a display. */
    "polaris.state": "polaris-actions",
    /** Its own settings as the person left them. */
    "settings.get": null,
    /**
     * Start the device's official app again, for an "Open <app>" button. It
     * needs no permission of its own: the app starts only the one program it
     * found registered for the add-on's device (`hercules-official-run.ts`),
     * never a path the add-on names, and an add-on with none is answered
     * false. A new permission would also make every older app refuse the
     * whole signed catalog the moment a manifest listed it.
     */
    "system.launchOfficial": null
} as const satisfies Record<string, AddonPermission | null>;

export type AddonMethod = keyof typeof ADDON_METHODS;

const callSchema = z.object({
    type: z.literal("call"),
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    method: z.string().max(64),
    params: z.unknown().optional()
});

export const addonMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]), text: z.string().max(2_000) }),
    /** What it wants the add-on's Settings page header to say about its device. */
    z.object({ type: z.literal("status"), state: z.enum(["connected", "sleeping", "busy", "error"]), detail: z.string().max(200).optional() }),
    callSchema
]);

export type AddonMessage = z.infer<typeof addonMessageSchema>;

export { ADDON_ACTIONS, type AddonAction } from "@polaris/core/device-addons";

/** The parameters of each method, checked before the app acts on them. */
export const ADDON_PARAMS = {
    "polaris.action": z.object({ action: z.enum(ADDON_ACTIONS) }),
    "polaris.state": z.undefined(),
    "settings.get": z.undefined(),
    "system.launchOfficial": z.undefined()
} as const satisfies Record<AddonMethod, z.ZodType>;

export type AppMessage =
    | { readonly type: "start"; readonly id: string; readonly version: string; readonly permissions: readonly AddonPermission[]; readonly devices: readonly UsbDevice[]; readonly settings: Record<string, AddonSettingValue>; }
    | { readonly type: "devices"; readonly devices: readonly UsbDevice[]; }
    | { readonly type: "settings"; readonly settings: Record<string, AddonSettingValue>; }
    | { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value: unknown; }
    | { readonly type: "reply"; readonly id: number; readonly ok: false; readonly error: "permission" | "unknown-method" | "bad-params" | "failed"; }
    | { readonly type: "stop"; };

export type CallVerdict =
    | { readonly ok: true; readonly method: AddonMethod; readonly params: unknown; }
    | { readonly ok: false; readonly error: "permission" | "unknown-method" | "bad-params"; };

/** Whether a call goes through: a known method, the permission it needs granted, and parameters of its shape. */
export function judgeCall(granted: readonly AddonPermission[], method: string, params: unknown): CallVerdict {
    if (!Object.hasOwn(ADDON_METHODS, method)) return { ok: false, error: "unknown-method" };
    const known = method as AddonMethod;
    const needs = ADDON_METHODS[known];
    if (needs !== null && !granted.includes(needs)) return { ok: false, error: "permission" };
    const parsed = ADDON_PARAMS[known].safeParse(params);
    return parsed.success ? { ok: true, method: known, params: parsed.data } : { ok: false, error: "bad-params" };
}

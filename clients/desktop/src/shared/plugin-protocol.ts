/**
 * What passes between the app and a running device plugin. The plugin runs in
 * its own process (an Electron utility process) and this is the only way it
 * reaches the app: every message it sends is checked here, and a call is only
 * answered when the plugin was granted the permission the method needs.
 *
 * The permissions gate what the APP does for a plugin. They do not sandbox the
 * plugin's own native code, which runs with the user's rights - that is why only
 * packages from the signed Polaris catalog are ever installed.
 */

import { z } from "zod";
import { pluginActionRefSchema, PLUGIN_STATUS_CODE, type PluginPermission, type PluginSettingValue, type UsbDevice } from "@polaris/core/device-plugins";

/** The methods a plugin may call, and the permission each one needs (null: none). */
export const PLUGIN_METHODS = {
    /** Run one of the app's own actions: call mute, deafen, push to talk... */
    "polaris.action": "polaris-actions",
    /** The calls and media playing now, for a display. */
    "polaris.state": "polaris-actions",
    /** Its own settings as the person left them. */
    "settings.get": null,
    /**
     * Start the device's official app again, for an "Open <app>" button. It
     * needs no permission of its own: the app starts only the one program it
     * found registered for the plugin's device (`hercules-official-run.ts`),
     * never a path the plugin names, and a plugin with none is answered
     * false. A new permission would also make every older app refuse the
     * whole signed catalog the moment a manifest listed it.
     */
    "system.launchOfficial": null
} as const satisfies Record<string, PluginPermission | null>;

export type PluginMethod = keyof typeof PLUGIN_METHODS;

const callSchema = z.object({
    type: z.literal("call"),
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    method: z.string().max(64),
    params: z.unknown().optional()
});

export const pluginMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({ type: z.literal("log"), level: z.enum(["info", "warn", "error"]), text: z.string().max(2_000) }),
    /** What it wants the plugin's Settings page header to say about its device. */
    z.object({ type: z.literal("status"), state: z.enum(["connected", "sleeping", "busy", "error"]), detail: z.string().max(200).optional(), code: PLUGIN_STATUS_CODE.optional() }),
    /** What its device shows now, for the plugin's page to follow live: each knob's name, volume and mute. */
    z.object({ type: z.literal("state"), knobs: z.array(z.object({ label: z.string().max(80), volume: z.number().int().min(0).max(100).nullable(), muted: z.boolean() })).max(8) }),
    /** What each channel plays now, 0-100 or null, sent only while a page watches (`watch`). */
    z.object({ type: z.literal("levels"), levels: z.array(z.number().int().min(0).max(100).nullable()).max(8) }),
    callSchema
]);

export type PluginMessage = z.infer<typeof pluginMessageSchema>;

export { PLUGIN_ACTIONS, type PluginAction } from "@polaris/core/device-plugins";

/** The parameters of each method, checked before the app acts on them. */
export const PLUGIN_PARAMS = {
    /** A call action, or `custom:<id>` / `launcher:<entry>`: the host looks up what it does, the plugin never knows. */
    "polaris.action": z.object({ action: pluginActionRefSchema }),
    "polaris.state": z.undefined(),
    "settings.get": z.undefined(),
    "system.launchOfficial": z.undefined()
} as const satisfies Record<PluginMethod, z.ZodType>;

export type AppMessage =
    | { readonly type: "start"; readonly id: string; readonly version: string; readonly permissions: readonly PluginPermission[]; readonly devices: readonly UsbDevice[]; readonly settings: Record<string, PluginSettingValue>; readonly locale?: string; readonly live?: boolean; }
    | { readonly type: "devices"; readonly devices: readonly UsbDevice[]; }
    | { readonly type: "settings"; readonly settings: Record<string, PluginSettingValue>; }
    | { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value: unknown; }
    | { readonly type: "reply"; readonly id: number; readonly ok: false; readonly error: "permission" | "unknown-method" | "bad-params" | "failed"; }
    | { readonly type: "watch"; readonly on: boolean; }
    | { readonly type: "stop"; };

export type CallVerdict =
    | { readonly ok: true; readonly method: PluginMethod; readonly params: unknown; }
    | { readonly ok: false; readonly error: "permission" | "unknown-method" | "bad-params"; };

/** Whether a call goes through: a known method, the permission it needs granted, and parameters of its shape. */
export function judgeCall(granted: readonly PluginPermission[], method: string, params: unknown): CallVerdict {
    if (!Object.hasOwn(PLUGIN_METHODS, method)) return { ok: false, error: "unknown-method" };
    const known = method as PluginMethod;
    const needs = PLUGIN_METHODS[known];
    if (needs !== null && !granted.includes(needs)) return { ok: false, error: "permission" };
    const parsed = PLUGIN_PARAMS[known].safeParse(params);
    return parsed.success ? { ok: true, method: known, params: parsed.data } : { ok: false, error: "bad-params" };
}

/** A plugin's live values, as its newest `state` message carried them. */
export type PluginLive = { readonly knobs: Extract<z.infer<typeof pluginMessageSchema>, { type: "state" }>["knobs"] };

/**
 * What the operator decides about the Calendar for everybody on this Polaris
 * (Nextcloud's app settings): whether people may subscribe to outside feeds,
 * whether they may run booking pages, and a few public calendars suggested to
 * everybody in the subscribe dialog.
 *
 * Kept in the `Setting` table under one key, read with a default for every
 * field so an instance that never opened the screen behaves as it always did.
 *
 * Server-only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { addressSchema, nameSchema } from "./schemas";

const KEY = "calendar.instance";

export const instanceSettingsSchema = z.object({
    /** People may subscribe to a calendar by its address. */
    allowSubscriptions: z.boolean(),
    /** People may publish booking pages. */
    allowBooking: z.boolean(),
    /** Public calendars offered to everybody in the subscribe dialog. */
    suggested: z.array(z.object({ name: nameSchema, url: addressSchema })).max(20)
});

export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = {
    allowSubscriptions: true,
    allowBooking: true,
    suggested: []
};

/** The settings as they stand, each missing or unreadable field its default. */
export async function readInstanceSettings(): Promise<InstanceSettings> {
    const raw = await host.settingStore.getSetting(KEY).catch(() => null);
    let stored: Record<string, unknown> = {};
    try {
        const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
    } catch {
        stored = {};
    }
    const shape = instanceSettingsSchema.shape;
    const pick = <K extends keyof InstanceSettings>(key: K): InstanceSettings[K] => {
        const result = shape[key].safeParse(stored[key]);
        return result.success
            ? (result.data as InstanceSettings[K])
            : DEFAULT_INSTANCE_SETTINGS[key];
    };
    return {
        allowSubscriptions: pick("allowSubscriptions"),
        allowBooking: pick("allowBooking"),
        suggested: pick("suggested")
    };
}

export async function writeInstanceSettings(settings: InstanceSettings): Promise<void> {
    await host.settingStore.setSetting(KEY, JSON.stringify(settings));
}

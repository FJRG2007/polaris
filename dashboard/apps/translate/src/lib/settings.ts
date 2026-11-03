/**
 * The owner's choices for Translate: which engines may answer and the
 * language a new translation goes into. Kept in the settings store; nothing
 * stored means the defaults in code, so a fresh install works untouched.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { readSettings, type TranslateSettings } from "../model/schemas";

const KEY = "translate.settings";

export async function loadSettings(): Promise<TranslateSettings> {
    const raw = await host.settingStore.getSetting(KEY);
    if (!raw) return readSettings(null);
    try {
        return readSettings(JSON.parse(raw));
    } catch {
        return readSettings(null);
    }
}

export async function saveSettings(settings: TranslateSettings): Promise<void> {
    await host.settingStore.setSetting(KEY, JSON.stringify(settings));
}

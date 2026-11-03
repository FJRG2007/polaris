"use server";

/**
 * What the Translate screen asks the server besides translating: the reader's
 * history, and the owner's settings. Each action validates its input first;
 * history is always the caller's own, settings need an administrator.
 */

import { host } from "@polaris/app-host";
import { translateT } from "../lib/i18n";
import * as history from "../lib/history";
import type { TranslateKey } from "../../messages";
import { loadSettings, saveSettings } from "../lib/settings";
import { idInput, rememberInput, settingsInput, type TranslateSettings } from "../model/schemas";

export type Outcome<T> =
    ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

async function refuse(key: TranslateKey): Promise<{ readonly ok: false; readonly error: string }> {
    return { ok: false, error: (await translateT())(key) };
}

/** Runs the work as the signed-in person; anything unexpected is logged, not shown. */
async function settle<T extends object>(
    work: (user: Awaited<ReturnType<typeof host.session.requirePermission>>) => Promise<T>
): Promise<Outcome<T>> {
    const user = await host.session.requirePermission("translate.use");
    try {
        return { ok: true, ...(await work(user)) };
    } catch (caught) {
        console.error("polaris: a translate action failed:", caught);
        return refuse("errors.generic");
    }
}

export async function historyAction(): Promise<Outcome<{ entries: history.HistoryEntry[] }>> {
    return settle(async (user) => ({ entries: await history.listHistory(user.id) }));
}

export async function rememberAction(
    input: unknown
): Promise<Outcome<{ entry: history.HistoryEntry }>> {
    const parsed = rememberInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    return settle(async (user) => ({ entry: await history.remember(user.id, parsed.data) }));
}

export async function forgetAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    return settle(async (user) => {
        await history.forget(user.id, parsed.data.id);
        return {};
    });
}

export async function forgetAllAction(): Promise<Outcome<object>> {
    return settle(async (user) => {
        await history.forgetAll(user.id);
        return {};
    });
}

/** The settings as the administrator's page edits them; nobody else reads them here. */
export async function settingsAction(): Promise<Outcome<{ settings: TranslateSettings }>> {
    const user = await host.session.requirePermission("translate.use");
    if (!user.isAdmin) return refuse("errors.adminOnly");
    return settle(async () => ({ settings: await loadSettings() }));
}

export async function saveSettingsAction(
    input: unknown
): Promise<Outcome<{ settings: TranslateSettings }>> {
    const parsed = settingsInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    const user = await host.session.requirePermission("translate.use");
    if (!user.isAdmin) return refuse("errors.adminOnly");
    return settle(async () => {
        await saveSettings(parsed.data);
        return { settings: parsed.data };
    });
}

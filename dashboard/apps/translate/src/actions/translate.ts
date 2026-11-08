"use server";

/**
 * What the Translate screen asks the server besides translating: the reader's
 * history, and the owner's settings. Each action validates its input first;
 * history and glossaries are always the caller's own, settings need an
 * administrator.
 */

import { host } from "@polaris/app-host";
import { translateT } from "../lib/i18n";
import * as history from "../lib/history";
import * as glossary from "../lib/glossary";
import type { TranslateKey } from "../../messages";
import { loadSettings, saveSettings } from "../lib/settings";
import {
    libreTranslateInput,
    loadLibreTranslate,
    saveLibreTranslate,
    type LibreTranslateConfig
} from "../lib/libretranslate";
import { keepInput, saveGlossaryInput } from "../model/glossary";
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

/** The LibreTranslate server, as the administrator's page shows it: the address, and whether a key is kept. */
export async function libreTranslateAction(): Promise<Outcome<{ server: LibreTranslateConfig }>> {
    const user = await host.session.requirePermission("translate.use");
    if (!user.isAdmin) return refuse("errors.adminOnly");
    return settle(async () => ({ server: await loadLibreTranslate() }));
}

/** Keeps a LibreTranslate address and key once the server answers with them. */
export async function saveLibreTranslateAction(
    input: unknown
): Promise<Outcome<{ server: LibreTranslateConfig }>> {
    const parsed = libreTranslateInput.safeParse(input);
    if (!parsed.success) return refuse("libretranslate.invalidUrl");
    const user = await host.session.requirePermission("translate.use");
    if (!user.isAdmin) return refuse("errors.adminOnly");
    try {
        return { ok: true, server: await saveLibreTranslate(parsed.data) };
    } catch (caught) {
        if (caught instanceof Error && caught.name === "EngineRefusal") {
            return refuse("libretranslate.unreachable");
        }
        console.error("polaris: saving the LibreTranslate server failed:", caught);
        return refuse("errors.generic");
    }
}

/** The caller's glossaries, without their terms, and their never-translate list. */
export async function glossariesAction(): Promise<
    Outcome<{ glossaries: glossary.GlossarySummary[]; keep: string[] }>
> {
    return settle(async (user) => {
        const [glossaries, keep] = await Promise.all([
            glossary.listGlossaries(user.id),
            glossary.getKeepList(user.id)
        ]);
        return { glossaries, keep };
    });
}

/** One of the caller's glossaries with its terms. */
export async function glossaryAction(
    input: unknown
): Promise<Outcome<{ glossary: glossary.Glossary }>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    const found = await settle(async (user) => ({
        glossary: await glossary.getGlossary(user.id, parsed.data.id)
    }));
    if (!found.ok) return found;
    if (!found.glossary) return refuse("glossary.errors.missing");
    return { ok: true, glossary: found.glossary };
}

/** A new glossary (no `id`), or one of the caller's changed. */
export async function saveGlossaryAction(
    input: unknown
): Promise<Outcome<{ glossary: glossary.Glossary }>> {
    const parsed = saveGlossaryInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    const { id, ...rest } = parsed.data;
    const user = await host.session.requirePermission("translate.use");
    try {
        const saved = await glossary.saveGlossary(user.id, id ?? null, rest);
        if (!saved) return refuse("glossary.errors.missing");
        return { ok: true, glossary: saved };
    } catch (caught) {
        if (caught instanceof glossary.GlossaryLimitError) return refuse("glossary.errors.limit");
        console.error("polaris: a glossary could not be saved:", caught);
        return refuse("glossary.errors.saveFailed");
    }
}

export async function deleteGlossaryAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    return settle(async (user) => {
        await glossary.deleteGlossary(user.id, parsed.data.id);
        return {};
    });
}

export async function saveKeepAction(input: unknown): Promise<Outcome<{ keep: string[] }>> {
    const parsed = keepInput.safeParse(input);
    if (!parsed.success) return refuse("errors.invalid");
    return settle(async (user) => ({ keep: await glossary.saveKeepList(user.id, parsed.data) }));
}

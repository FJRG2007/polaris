"use client";

/**
 * Note templates kept on this device, so a note made while Polaris cannot be
 * reached starts from its template here and now instead of blank until it is
 * sent. The server still applies the template when the note reaches it; the
 * copy kept here is only what the screen draws in the meantime.
 *
 * Each visit to Notes compares the versions the page lists with the copies
 * kept, and asks for the ones that changed in one request - none when nothing
 * did. Kept in the account's own store, deleted with it on sign-out.
 */

import * as actions from "./actions";
import { useEffect } from "react";
import { offlineStore } from "@/lib/offline/app-writes";
import type { NoteTemplateContent, NoteTemplateSummary } from "@/lib/notes/template-service";

const KIND = "templates";

/** The title and text of a template this device keeps, if it keeps it. */
export async function keptTemplate(templateId: string): Promise<{ title: string; body: string } | null> {
    const kept = await offlineStore.read<NoteTemplateContent>(KIND, templateId).catch(() => null);
    return kept ? { title: kept.title, body: kept.body } : null;
}

/** Bring the copies kept here up to the versions listed. Answers how many were
 *  fetched; a failure leaves the older copies as they were. */
export async function refreshKeptTemplates(listed: readonly NoteTemplateSummary[]): Promise<number> {
    if (!offlineStore.owner() || listed.length === 0) return 0;
    const stale: string[] = [];
    for (const template of listed) {
        const kept = await offlineStore.read<NoteTemplateContent>(KIND, template.id).catch(() => null);
        if (kept?.version !== template.version) stale.push(template.id);
    }
    if (stale.length === 0) return 0;
    const fetched = await actions.templateContentsAction(stale).catch(() => []);
    for (const content of fetched) await offlineStore.write(KIND, content.id, content);
    return fetched.length;
}

/** Keep the templates a screen lists, once per change of what it lists. */
export function useKeptTemplates(listed: readonly NoteTemplateSummary[]): void {
    const signature = listed.map((template) => `${template.id}@${template.version}`).join(",");
    useEffect(() => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;
        void refreshKeptTemplates(listed);
        // `signature` is what `listed` holds; a new array with the same
        // templates must not ask again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
}

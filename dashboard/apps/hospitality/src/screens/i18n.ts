/**
 * Hospitality' words in the browser, in the language the page is drawn in.
 */

import { hospitalityCatalogs } from "../../messages";
import { hostUi } from "@polaris/app-host/client";
import { reportReach } from "./connection";
import type { HospitalityTranslator } from "../lib/i18n";

export function useHospitalityT(): HospitalityTranslator {
    return hospitalityCatalogs.translator(
        hostUi.i18nProvider.useLocale(),
        "hospitality",
        hostUi.i18nProvider.useClient()
    );
}

export function useHospitalityLocale(): string {
    return hostUi.i18nProvider.useLocale();
}

/** An action's `{ ok, error }` answer as a value or a thrown sentence. */
export async function unwrap<T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string
): Promise<Extract<T, { ok: true }>> {
    let failure = fallback;
    const answer = await hostUi.runAction.runAction(call, (message) => {
        failure = message;
    });
    // No answer at all is the server away (restarting, updating, unreachable): the banner says so.
    reportReach(Boolean(answer));
    if (!answer) throw new Error(failure);
    if (!answer.ok) throw new Error((answer as unknown as { error: string }).error);
    return answer as Extract<T, { ok: true }>;
}

/** Reads what the last visit cached, or null. Never throws. */
export function readCache<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(`hospitality:${key}`);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

export function writeCache(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(`hospitality:${key}`, JSON.stringify(value));
    } catch {
        // Private windows and full storage: the next visit loads from the server.
    }
}

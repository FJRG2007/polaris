"use client";

/**
 * What a Polar chat shows, on this device and on the server: the switches in
 * Polar's settings and the pieces of the chat they hide. The last known value
 * is kept on the device so a chat paints with it at once; the server's answer
 * replaces it when it differs. A switch shows its change at once and is put
 * back if the server refuses it.
 */

import { useSyncExternalStore } from "react";
import { Switch, useToast } from "@polaris/ui";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    displayOf,
    POLAR_DISPLAY_KEYS,
    POLAR_DISPLAY_DEFAULTS,
    type PolarDisplay,
    type PolarDisplayKey
} from "@/lib/polar/display";

const CACHE_KEY = "polar.display";

let current: PolarDisplay | null = null;
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();

function cached(): PolarDisplay {
    try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        return raw ? displayOf(JSON.parse(raw)) : POLAR_DISPLAY_DEFAULTS;
    } catch {
        return POLAR_DISPLAY_DEFAULTS;
    }
}

/** The display settings as the chat reads them, shared by every component. */
export const polarDisplayStore = {
    get(): PolarDisplay {
        current ??= typeof window === "undefined" ? POLAR_DISPLAY_DEFAULTS : cached();
        return current;
    },
    set(next: PolarDisplay): void {
        const before = polarDisplayStore.get();
        if (sameDisplay(before, next)) return;
        current = next;
        try {
            window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
        } catch {
            // Not kept on this device; the server still has it.
        }
        for (const listener of listeners) listener();
    },
    /** The settings once the server has answered, or the device's copy if it could not. */
    load(): Promise<PolarDisplay> {
        request ??= fetch("/api/polar/preferences")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: unknown) => (data ? polarDisplayStore.set(displayOf(data)) : undefined))
            .catch(() => undefined);
        return request.then(() => polarDisplayStore.get());
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        void polarDisplayStore.load();
        return () => listeners.delete(listener);
    }
};

function sameDisplay(a: PolarDisplay, b: PolarDisplay): boolean {
    return POLAR_DISPLAY_KEYS.every((key) => a[key] === b[key]);
}

export function usePolarDisplay(): PolarDisplay {
    return useSyncExternalStore(
        polarDisplayStore.subscribe,
        polarDisplayStore.get,
        () => POLAR_DISPLAY_DEFAULTS
    );
}

/** Turns one switch, at once, and back again when the server says no. */
export async function changePolarDisplay(key: PolarDisplayKey, value: boolean): Promise<boolean> {
    const before = polarDisplayStore.get();
    if (before[key] === value) return true;
    polarDisplayStore.set({ ...before, [key]: value });
    const response = await fetch("/api/polar/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value })
    }).catch(() => null);
    if (response?.ok) return true;
    polarDisplayStore.set({ ...polarDisplayStore.get(), [key]: before[key] });
    return false;
}

/** The suggestion switch lives with the helper model (`polar-helper-settings.tsx`). */
type DisplayRow = Exclude<PolarDisplayKey, "suggestions">;

const ROWS: readonly {
    key: DisplayRow;
    hint?: "settings.display.autoCompactHint" | "settings.display.reopenLastChatHint";
}[] = [
    { key: "showTokens" },
    { key: "showCost" },
    { key: "showContextBar" },
    { key: "autoCompact", hint: "settings.display.autoCompactHint" },
    { key: "reopenLastChat", hint: "settings.display.reopenLastChatHint" }
];

/** The "Chat display" section of Polar's settings. */
export function DisplaySettings() {
    const t = useTranslations("polar");
    const toast = useToast();
    const display = usePolarDisplay();
    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">
                    {t("settings.display.title")}
                </h2>
                <p className="text-xs text-muted-foreground">{t("settings.display.intro")}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {ROWS.map(({ key, hint }) => (
                    <li key={key} className="flex min-w-0 items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm text-foreground">
                                {t(`settings.display.${key}`)}
                            </p>
                            {hint ? (
                                <p className="text-xs text-muted-foreground">{t(hint)}</p>
                            ) : null}
                        </div>
                        <Switch
                            checked={display[key]}
                            aria-label={t(`settings.display.${key}`)}
                            onChange={(value) =>
                                void changePolarDisplay(key, value).then((saved) =>
                                    saved
                                        ? undefined
                                        : toast.show({ title: t("settings.display.failed") })
                                )
                            }
                        />
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** What one answer spent, as its metadata carries it. */
export interface AnswerSpend {
    input: number;
    output: number;
    cached: number | null;
    reasoning: number | null;
    cost: number | null;
}

/** An answer's spend from its metadata, or null when it carries none. */
export function answerSpendOf(usage: unknown): AnswerSpend | null {
    const entry = (usage ?? {}) as Record<string, unknown>;
    const count = (value: unknown) => (typeof value === "number" ? value : null);
    const input = count(entry.inputTokens);
    const output = count(entry.outputTokens);
    if (input === null || output === null) return null;
    return {
        input,
        output,
        cached: count(entry.cachedTokens),
        reasoning: count(entry.reasoningTokens),
        cost: count(entry.costUsd)
    };
}

/**
 * The tokens and estimated cost under an answer, each hidden by its own
 * switch. Hovering the tokens shows them split into input, cached input,
 * output and reasoning - the last two only when the provider reported them.
 */
export function AnswerSpendLine({ spent }: { spent: AnswerSpend }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const display = usePolarDisplay();
    const showCost = display.showCost && spent.cost !== null;
    if (!display.showTokens && !showCost) return null;
    const breakdown = [
        t("usage.breakdownInput", { count: formatTokens(spent.input, locale) }),
        spent.cached !== null
            ? t("usage.breakdownCached", { count: formatTokens(spent.cached, locale) })
            : null,
        t("usage.breakdownOutput", { count: formatTokens(spent.output, locale) }),
        spent.reasoning !== null
            ? t("usage.breakdownReasoning", { count: formatTokens(spent.reasoning, locale) })
            : null
    ]
        .filter(Boolean)
        .join("\n");
    return (
        <>
            {display.showTokens ? (
                <span className="tabular-nums" title={breakdown} data-polar-spend="tokens">
                    {` - ${t("usage.answer", { tokens: formatTokens(spent.input + spent.output, locale) })}`}
                </span>
            ) : null}
            {showCost && spent.cost !== null ? (
                <span className="tabular-nums" data-polar-spend="cost">
                    {` - ${t("usage.cost", { cost: formatUsd(spent.cost, locale) })}`}
                </span>
            ) : null}
        </>
    );
}

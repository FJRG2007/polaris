"use client";

/**
 * What a Polar chat shows, on this device and on the server: the switches in
 * Polar's settings and the pieces of the chat they hide. The last known value
 * is kept on the device so a chat paints with it at once; the server's answer
 * replaces it when it differs. A switch shows its change at once and is put
 * back if the server refuses it.
 */

import { useSyncExternalStore } from "react";
import { Select, Switch, useToast } from "@polaris/ui";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    displayOf,
    POLAR_DISPLAY_KEYS,
    POLAR_DISPLAY_DEFAULTS,
    type PolarDisplay,
    type PolarDisplayKey
} from "@/lib/polar/display";
import { CODE_THEMES, codeThemeOf, DEFAULT_CODE_THEME, type CodeTheme } from "@/lib/polar/code-theme";

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
            .then((data: unknown) => {
                if (!data) return;
                polarDisplayStore.set(displayOf(data));
                codeThemeStore.set(codeThemeOf((data as { codeTheme?: unknown }).codeTheme));
            })
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

const THEME_CACHE_KEY = "polar.codeTheme";
let theme: CodeTheme | null = null;
const themeListeners = new Set<() => void>();

/** Polar Code's color theme, read with the rest of Polar's settings: the
 *  device's last known one at once, the server's when it answers. */
export const codeThemeStore = {
    get(): CodeTheme {
        if (theme === null) {
            if (typeof window === "undefined") return DEFAULT_CODE_THEME;
            try {
                theme = codeThemeOf(window.localStorage.getItem(THEME_CACHE_KEY));
            } catch {
                theme = DEFAULT_CODE_THEME;
            }
        }
        return theme;
    },
    set(next: CodeTheme): void {
        if (codeThemeStore.get() === next) return;
        theme = next;
        try {
            window.localStorage.setItem(THEME_CACHE_KEY, next);
        } catch {
            // Not kept on this device; the server still has it.
        }
        for (const listener of themeListeners) listener();
    },
    subscribe(listener: () => void): () => void {
        themeListeners.add(listener);
        void polarDisplayStore.load();
        return () => themeListeners.delete(listener);
    }
};

export function useCodeTheme(): CodeTheme {
    return useSyncExternalStore(codeThemeStore.subscribe, codeThemeStore.get, () => DEFAULT_CODE_THEME);
}

/** Changes the theme at once, and puts the old one back when the server says no. */
export async function changeCodeTheme(next: CodeTheme): Promise<boolean> {
    const before = codeThemeStore.get();
    if (before === next) return true;
    codeThemeStore.set(next);
    const response = await fetch("/api/polar/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeTheme: next })
    }).catch(() => null);
    if (response?.ok) return true;
    codeThemeStore.set(before);
    return false;
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

/** The suggestion switch lives with the helper model (`polar-helper-settings.tsx`),
 *  and which chat opens with "When Polar opens" (`polar-open-settings.tsx`). */
type DisplayRow = Exclude<PolarDisplayKey, "suggestions" | "reopenLastChat">;

const ROWS: readonly {
    key: DisplayRow;
    hint?: "settings.display.autoCompactHint";
}[] = [
    { key: "showTokens" },
    { key: "showCost" },
    { key: "showContextBar" },
    { key: "autoCompact", hint: "settings.display.autoCompactHint" }
];

/** A theme's colors in a row of dots, painted by the theme itself. */
function ThemeSwatch({ theme }: { theme: CodeTheme }) {
    return (
        <span data-code-theme={theme} aria-hidden className="flex shrink-0 items-center gap-0.5">
            {(["keyword", "string", "function", "number"] as const).map((token) => (
                <span
                    key={token}
                    className="size-2 rounded-full"
                    style={{ backgroundColor: `hsl(var(--code-${token}))` }}
                />
            ))}
        </span>
    );
}

/** The "Code color theme" section of Polar's settings. */
function CodeThemeSettings() {
    const t = useTranslations("polar");
    const toast = useToast();
    const theme = useCodeTheme();
    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t("settings.codeTheme.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.codeTheme.intro")}</p>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">{t("settings.codeTheme.label")}</p>
                <Select
                    value={theme}
                    aria-label={t("settings.codeTheme.label")}
                    className="w-44"
                    onValueChange={(value) =>
                        void changeCodeTheme(codeThemeOf(value)).then((saved) =>
                            saved ? undefined : toast.show({ title: t("settings.codeTheme.failed") })
                        )
                    }
                    options={CODE_THEMES.map((name) => ({
                        value: name,
                        label: t(`settings.codeTheme.names.${name}`),
                        icon: <ThemeSwatch theme={name} />
                    }))}
                />
            </div>
        </section>
    );
}

/** The "Chat display" section of Polar's settings, and Code's theme under it. */
export function DisplaySettings() {
    return (
        <div className="flex flex-col gap-6">
            <ChatDisplaySettings />
            <CodeThemeSettings />
        </div>
    );
}

function ChatDisplaySettings() {
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

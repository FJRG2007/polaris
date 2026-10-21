"use client";

/**
 * The one read of `/api/polar/models` the settings page makes, shared by the
 * sections that need it (the tools, the helper model): the answer as last
 * seen at once, then the server's. Sections mounting together share a single
 * request, since the route lists every connector's tools to answer.
 */

import { useEffect, useState } from "react";
import type { ServedTool } from "@/lib/polar/tool-servers";
import type { ModelSelectorProvider } from "@/components/polar/elements/model-selector";

export interface SettingsModels {
    /** Null when the answer did not carry them: a pick is not reported unavailable then. */
    providers: ModelSelectorProvider[] | null;
    tools: Record<string, ServedTool>;
    web: boolean;
    connectors: boolean;
}

const CACHE_KEY = "polar.settingsTools";

let pending: Promise<SettingsModels> | null = null;

function readCache(): SettingsModels | null {
    try {
        const raw = window.sessionStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw) as Partial<SettingsModels>;
        return {
            providers: Array.isArray(cached.providers) ? cached.providers : null,
            tools: cached.tools ?? {},
            web: cached.web !== false,
            connectors: cached.connectors === true
        };
    } catch {
        return null;
    }
}

function request(): Promise<SettingsModels> {
    pending ??= fetch("/api/polar/models")
        .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then((data: Partial<SettingsModels>) => {
            const next: SettingsModels = {
                providers: Array.isArray(data.providers) ? data.providers : null,
                tools: data.tools ?? {},
                // Not knowing is not a refusal: the chat route drops web
                // search where an administrator turned it off.
                web: data.web !== false,
                connectors: data.connectors === true
            };
            try {
                window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(next));
            } catch {
                // Not cached; the next visit asks again.
            }
            return next;
        })
        .finally(() => {
            pending = null;
        });
    return pending;
}

/** The answer (null until one is known), whether the last request failed,
 *  and a way to ask again. A failure keeps the answer last seen. */
export function useSettingsModels(): {
    answer: SettingsModels | null;
    failed: boolean;
    retry: () => void;
} {
    const [answer, setAnswer] = useState<SettingsModels | null>(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let live = true;
        const cached = readCache();
        if (cached) setAnswer((current) => current ?? cached);
        setFailed(false);
        request().then(
            (next) => {
                if (live) setAnswer(next);
            },
            () => {
                if (live) setFailed(true);
            }
        );
        return () => {
            live = false;
        };
    }, [attempt]);
    return { answer, failed, retry: () => setAttempt((count) => count + 1) };
}

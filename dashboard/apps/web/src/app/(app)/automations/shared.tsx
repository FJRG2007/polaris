"use client";

/**
 * Pieces every /automations screen shares: a cached loader (last value drawn at
 * once, refetched behind it), the status chip, and run errors in words.
 */

import { Badge, Button, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

function readCache<T>(key: string): { at: number; value: T } | null {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { at: number; value: T }) : null;
    } catch {
        return null;
    }
}

function writeCache(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
    } catch {
        // Storage refused (private window, full): the screen works without it.
    }
}

export type Loaded<T> = { ok: true } & T;
type Answer<T> = Loaded<T> | { ok: false; error: string };

/**
 * Load through a server action, stale-while-revalidate: a cached answer is
 * shown at once and replaced only when the fresh one differs.
 */
export function useCachedAction<T extends object>(key: string, load: () => Promise<Answer<T>>) {
    const [data, setData] = useState<Loaded<T> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const loader = useRef(load);
    loader.current = load;

    const refresh = useCallback(async () => {
        setError(null);
        try {
            const answer = await loader.current();
            if (!answer.ok) {
                setError(answer.error);
                return;
            }
            setData((before) => (JSON.stringify(before) === JSON.stringify(answer) ? before : answer));
            writeCache(key, answer);
        } catch {
            setError("");
        }
    }, [key]);

    useEffect(() => {
        const cached = readCache<Loaded<T>>(key);
        if (cached) setData(cached.value);
        // Always revalidated: the cache only spares the first paint the wait.
        void refresh();
    }, [key, refresh]);

    const replace = useCallback(
        (update: (current: Loaded<T>) => Loaded<T>) =>
            setData((current) => {
                if (!current) return current;
                const next = update(current);
                writeCache(key, next);
                return next;
            }),
        [key]
    );

    return { data, error, refresh, replace };
}

export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
            ))}
        </div>
    );
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
    const t = useTranslations("automations");
    return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
            <span className="min-w-0">{message}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
                {t("list.retry")}
            </Button>
        </div>
    );
}

const TONES: Record<string, "neutral" | "primary" | "success" | "warning" | "danger"> = {
    succeeded: "success",
    failed: "danger",
    refused: "danger",
    timedOut: "danger",
    running: "primary",
    waiting: "primary",
    queued: "warning",
    limited: "warning"
};

const STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "stopped", "cancelled", "refused", "limited", "skipped", "timedOut"] as const;
type Status = (typeof STATUSES)[number];

export function StatusChip({ status }: { status: string }) {
    const t = useTranslations("automations");
    const known = (STATUSES as readonly string[]).includes(status) ? (status as Status) : "failed";
    return <Badge variant={TONES[known] ?? "neutral"}>{t(`status.${known}`)}</Badge>;
}

const RUN_ERRORS = [
    "alreadyRunning",
    "queueFull",
    "rateLimited",
    "loop",
    "timeout",
    "interrupted",
    "appMissing",
    "runAsGone",
    "badConfig",
    "addressRefused",
    "unreachable",
    "secretMissing",
    "tooManySteps",
    "tooMuchData",
    "runTooLong",
    "cancelledByPerson",
    "restarted",
    "waitTooLong",
    "badUrl",
    "responseTooLarge",
    "tooManyRedirects",
    "graphUnreadable",
    "nodeMissing"
] as const;

/** A stored error code in the reader's words. */
export function useRunError(): (code: string | null) => string | null {
    const t = useTranslations("automations");
    return (code) => {
        if (!code) return null;
        const bare = code.replace(/^finally:/, "");
        if (bare.startsWith("httpStatus:")) return t("runErrors.httpStatus", { status: bare.slice("httpStatus:".length) });
        if ((RUN_ERRORS as readonly string[]).includes(bare)) return t(`runErrors.${bare as (typeof RUN_ERRORS)[number]}`);
        return t("runErrors.other");
    };
}

export function Section({ title, hint, children, action }: { title: string; hint?: string; children: ReactNode; action?: ReactNode }) {
    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

export function when(iso: string | null, locale: string): string {
    return iso ? new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "";
}

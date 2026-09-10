"use client";

/**
 * The small pieces every mail server screen shares: a labelled field, the badge
 * a verdict is shown with, and the hook that loads a panel's data after the
 * first paint and keeps it for half a minute so switching tabs does not ask the
 * engine the same question again.
 */

import { Badge, cn } from "@polaris/ui";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

type Answer<T> = { error: string } | ({ error?: undefined } & T);

/** How long a panel's data is reused before it is asked for again. */
const CACHE_TTL_MS = 30_000;

function readCache<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(`mail-server:${key}`);
        if (!raw) return null;
        const entry = JSON.parse(raw) as { at: number; value: T };
        return Date.now() - entry.at < CACHE_TTL_MS ? entry.value : null;
    } catch {
        return null;
    }
}

function writeCache<T>(key: string, value: T): void {
    try {
        sessionStorage.setItem(`mail-server:${key}`, JSON.stringify({ at: Date.now(), value }));
    } catch {
        // A browser that will not store it just asks again next time.
    }
}

/** Drop what is kept for a panel, after a change another screen shows. */
export function forgetPanelData(key: string): void {
    try {
        sessionStorage.removeItem(`mail-server:${key}`);
    } catch {
        // Nothing kept, nothing to drop.
    }
}

/**
 * Load a panel's data once it is on screen. `reload` asks again past the cache,
 * which is what every change calls afterwards so the panel shows what the
 * engine now says rather than what was typed.
 */
export function usePanelData<T extends object>(
    key: string,
    load: () => Promise<Answer<T>>
): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const loader = useRef(load);
    loader.current = load;

    const fetchNow = useCallback(async () => {
        setLoading(true);
        const answer = await loader.current().catch(() => ({ error: "Polaris could not be reached." }) as Answer<T>);
        if ("error" in answer && answer.error) {
            setError(answer.error);
        } else {
            setError(null);
            setData(answer as T);
            writeCache(key, answer);
        }
        setLoading(false);
    }, [key]);

    useEffect(() => {
        const cached = readCache<T>(key);
        if (cached) {
            setData(cached);
            setLoading(false);
            return;
        }
        void fetchNow();
    }, [key, fetchNow]);

    return { data, error, loading, reload: fetchNow };
}

export function Field({
    label,
    hint,
    error,
    required,
    children
}: {
    label: string;
    hint?: ReactNode;
    error?: string | null;
    required?: boolean;
    children: (id: string) => ReactNode;
}) {
    const id = useId();
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
                {label}
                {required ? <span className="text-foreground-subtle"> *</span> : null}
            </label>
            {children(id)}
            {error ? (
                <p className="text-xs text-danger">{error}</p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

export type Verdict = "pass" | "warn" | "fail" | "unverified";

const VERDICT_LABEL: Record<Verdict, string> = {
    pass: "Pass",
    warn: "Check",
    fail: "Fail",
    unverified: "Unverified"
};

export function VerdictBadge({ verdict, label }: { verdict: Verdict; label?: string }) {
    const variant = verdict === "pass" ? "success" : verdict === "warn" ? "warning" : verdict === "fail" ? "danger" : "neutral";
    return <Badge variant={variant}>{label ?? VERDICT_LABEL[verdict]}</Badge>;
}

/** The server's state, as one badge. */
export function StatusBadge({ status }: { status: string }) {
    if (status === "ready") return <Badge variant="success">Running</Badge>;
    if (status === "down") return <Badge variant="danger">Not answering</Badge>;
    if (status === "failed") return <Badge variant="danger">Setup stopped</Badge>;
    return <Badge variant="primary">Setting up</Badge>;
}

/** A sentence a panel could not load past. */
export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[0.8125rem] text-danger">
            <span>{message}</span>
            {onRetry ? (
                <button type="button" className="shrink-0 text-xs font-medium underline" onClick={onRetry}>
                    Try again
                </button>
            ) : null}
        </div>
    );
}

/** A value meant to be copied into somebody else's control panel. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
    return <code className={cn("break-all font-mono text-xs text-foreground", className)}>{children}</code>;
}

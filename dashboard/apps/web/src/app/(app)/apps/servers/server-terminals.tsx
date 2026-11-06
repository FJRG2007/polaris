"use client";

/**
 * Several shells on one server, each a long-lived session held by the terminal
 * sidecar. Closing this, reloading, or losing the connection leaves them
 * running; opening it again lists them and returns to where each one was. Only
 * the selected tab holds a socket - switching tabs detaches one session and
 * reattaches another, whose scrollback is replayed.
 *
 * The list comes from the sidecar through the web app, scoped to the caller, so
 * nobody ever sees a session they did not open.
 */

import { Pencil, Plus, X } from "lucide-react";
import { Button, Input, Skeleton, cn } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { TerminalPanel, type FindServerResult } from "../deploy/terminal-panel";

interface Session {
    id: string;
    name: string | null;
    number: number;
    mode: "ssh" | "ssh-root";
}

interface Listing {
    sessions: Session[];
    used: number;
    cap: number;
    idleMinutes: number;
}

/** A tab not yet backed by a session: the shell is being opened. */
const PENDING = "pending";

/** Which tab to land on: the most recent session in the mode asked for, or a
 *  new one. Pure. */
export function initialTab(sessions: Session[], asRoot: boolean): string {
    const mode = asRoot ? "ssh-root" : "ssh";
    const match = sessions.filter((s) => s.mode === mode);
    return match[match.length - 1]?.id ?? PENDING;
}

export function ServerTerminals({
    hostId,
    asRoot,
    login,
    address,
    findServer
}: {
    hostId: string;
    asRoot: boolean;
    /** The account a non-root shell signs in as. */
    login: string;
    address: string;
    findServer?: () => Promise<FindServerResult>;
}) {
    const t = useTranslations("common");
    const [listing, setListing] = useState<Listing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [active, setActive] = useState<string | null>(null);
    // The mode a pending tab opens in, and the panel key it keeps once its
    // session id arrives, so the socket is not torn down and reopened.
    const [pendingRoot, setPendingRoot] = useState(asRoot);
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [pendingKey, setPendingKey] = useState(0);
    const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
    const [closing, setClosing] = useState<string | null>(null);
    const mounted = useRef(true);
    // Read through a ref so a new translator identity never refetches the list.
    const tRef = useRef(t);
    tRef.current = t;

    const load = useCallback(async (): Promise<Listing | null> => {
        const res = await fetch(
            `/api/deploy/terminal/sessions?hostId=${encodeURIComponent(hostId)}`,
            {
                cache: "no-store"
            }
        ).catch(() => null);
        const body = (await res?.json().catch(() => null)) as (Listing & { error?: string }) | null;
        if (!mounted.current) return null;
        if (!res?.ok || !body || !Array.isArray(body.sessions)) {
            setError(body?.error ?? tRef.current("terminal.sessions.loadFailed"));
            return null;
        }
        setError(null);
        setListing(body);
        return body;
    }, [hostId]);

    useEffect(() => {
        mounted.current = true;
        void load().then((list) => {
            if (!mounted.current) return;
            const first = list ? initialTab(list.sessions, asRoot) : PENDING;
            if (first === PENDING && list && list.used >= list.cap) setActive(null);
            else setActive(first);
        });
        return () => {
            mounted.current = false;
        };
    }, [load, asRoot]);

    const sessions = listing?.sessions ?? [];
    const atCap = listing ? listing.used >= listing.cap : false;
    const activeSession = sessions.find((s) => s.id === active);

    const name = (s: Session): string =>
        s.name ?? t("terminal.sessions.defaultName", { n: s.number });

    const openNew = (root: boolean): void => {
        setPendingRoot(root);
        setPendingKey((n) => n + 1);
        setActive(PENDING);
    };

    const onSession = (id: string, number: number): void => {
        // A pending tab learns its id: keep its panel key and list it at once,
        // so the panel stays mounted on the same socket, then refresh.
        if (active !== PENDING) return;
        setKeys((k) => (k[id] ? k : { ...k, [id]: `${PENDING}-${pendingKey}` }));
        const mode = pendingRoot ? "ssh-root" : "ssh";
        setListing((l) =>
            l && !l.sessions.some((s) => s.id === id)
                ? {
                      ...l,
                      used: l.used + 1,
                      sessions: [...l.sessions, { id, name: null, number, mode }]
                  }
                : l
        );
        setActive((current) => (current === PENDING ? id : current));
        void load();
    };

    const onClosed = (): void => {
        // The shell may have ended (`exit`, idle, closed elsewhere): drop the
        // tab if the session is gone, otherwise leave the panel's note showing.
        void load().then((list) => {
            if (!list) return;
            setActive((current) =>
                current && current !== PENDING && !list.sessions.some((s) => s.id === current)
                    ? (list.sessions[list.sessions.length - 1]?.id ?? null)
                    : current
            );
        });
    };

    const change = async (body: Record<string, string>): Promise<boolean> => {
        const res = await fetch("/api/deploy/terminal/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hostId, ...body })
        }).catch(() => null);
        if (res?.ok) return true;
        const reason = (await res?.json().catch(() => null)) as { error?: string } | null;
        if (mounted.current) setError(reason?.error ?? t("terminal.sessions.changeFailed"));
        return false;
    };

    const commitRename = async (): Promise<void> => {
        if (!renaming || !listing) return;
        const target = sessions.find((s) => s.id === renaming.id);
        setRenaming(null);
        const value = renaming.value.trim().slice(0, 60);
        if (!target || (target.name ?? "") === value) return;
        const before = listing;
        // Optimistic, rolled back if the sidecar says no.
        setListing({
            ...listing,
            sessions: sessions.map((s) => (s.id === target.id ? { ...s, name: value || null } : s))
        });
        if (!(await change({ action: "rename", id: target.id, name: value })) && mounted.current) {
            setListing(before);
        }
    };

    const confirmClose = async (id: string): Promise<void> => {
        if (!listing) return;
        setClosing(null);
        const before = listing;
        const rest = sessions.filter((s) => s.id !== id);
        setListing({ ...listing, sessions: rest, used: Math.max(0, listing.used - 1) });
        if (active === id) setActive(rest[rest.length - 1]?.id ?? null);
        if (!(await change({ action: "close", id })) && mounted.current) {
            setListing(before);
            void load();
        }
    };

    const closingSession = sessions.find((s) => s.id === closing);
    const panelRoot = active === PENDING ? pendingRoot : activeSession?.mode === "ssh-root";

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-1">
                <div
                    className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                    role="tablist"
                >
                    {listing === null && !error ? <Skeleton className="h-7 w-24" /> : null}
                    {sessions.map((s) =>
                        renaming?.id === s.id ? (
                            <Input
                                key={s.id}
                                autoFocus
                                aria-label={t("terminal.sessions.renameLabel")}
                                className="h-7 w-40 shrink-0 text-xs"
                                maxLength={60}
                                value={renaming.value}
                                placeholder={t("terminal.sessions.defaultName", { n: s.number })}
                                onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
                                onBlur={() => void commitRename()}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") void commitRename();
                                    if (e.key === "Escape") setRenaming(null);
                                }}
                            />
                        ) : (
                            <div
                                key={s.id}
                                className={cn(
                                    "group flex h-7 min-w-0 max-w-48 shrink-0 items-center gap-0.5 rounded-md border px-1 text-xs",
                                    s.id === active
                                        ? "border-border bg-muted text-foreground"
                                        : "border-transparent text-muted-foreground hover:bg-muted/60"
                                )}
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={s.id === active}
                                    title={name(s)}
                                    className="flex min-w-0 items-center gap-1 px-1"
                                    onClick={() => setActive(s.id)}
                                    onDoubleClick={() =>
                                        setRenaming({ id: s.id, value: s.name ?? "" })
                                    }
                                >
                                    <span className="min-w-0 truncate">{name(s)}</span>
                                    {s.mode === "ssh-root" ? (
                                        <span className="shrink-0 rounded bg-warning-soft px-1 text-[0.625rem] text-warning">
                                            {t("terminal.sessions.root")}
                                        </span>
                                    ) : null}
                                </button>
                                <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={t("terminal.sessions.rename")}
                                    title={t("terminal.sessions.rename")}
                                    className="shrink-0"
                                    onClick={() => setRenaming({ id: s.id, value: s.name ?? "" })}
                                >
                                    <Pencil />
                                </Button>
                                <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={t("terminal.sessions.close")}
                                    title={t("terminal.sessions.close")}
                                    className="shrink-0"
                                    onClick={() => setClosing(s.id)}
                                >
                                    <X />
                                </Button>
                            </div>
                        )
                    )}
                    {active === PENDING ? (
                        <span
                            role="tab"
                            aria-selected
                            className="flex h-7 shrink-0 items-center rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground"
                        >
                            {t("terminal.sessions.opening")}
                        </span>
                    ) : null}
                </div>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={atCap || active === PENDING}
                    aria-label={t("terminal.sessions.newTab")}
                    title={
                        atCap
                            ? t("terminal.sessions.limit", { cap: listing?.cap ?? 0 })
                            : t("terminal.sessions.newTab")
                    }
                    onClick={() => openNew(asRoot)}
                >
                    <Plus className="size-4" />
                </Button>
            </div>

            {closingSession ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1">
                        {t("terminal.sessions.closeAsk", { name: name(closingSession) })}
                    </span>
                    <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void confirmClose(closingSession.id)}
                    >
                        {t("terminal.sessions.closeConfirm")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setClosing(null)}>
                        {t("terminal.sessions.cancel")}
                    </Button>
                </div>
            ) : null}

            {error ? <p className="text-xs text-danger">{error}</p> : null}

            {active === PENDING || activeSession ? (
                <TerminalPanel
                    key={
                        active === PENDING
                            ? `${PENDING}-${pendingKey}`
                            : (keys[activeSession!.id] ?? activeSession!.id)
                    }
                    target={{ kind: "host", hostId, asRoot: panelRoot }}
                    label={`${panelRoot ? "root" : login}@${address}`}
                    resumeId={active === PENDING ? undefined : activeSession!.id}
                    onSession={onSession}
                    onClosed={onClosed}
                    findServer={findServer}
                />
            ) : listing ? (
                <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed text-center text-xs text-muted-foreground">
                    <p className="max-w-sm px-4">
                        {atCap
                            ? t("terminal.sessions.limit", { cap: listing.cap })
                            : t("terminal.sessions.empty")}
                    </p>
                    {atCap ? null : (
                        <Button size="sm" variant="secondary" onClick={() => openNew(asRoot)}>
                            <Plus className="size-3.5" /> {t("terminal.sessions.newTab")}
                        </Button>
                    )}
                </div>
            ) : (
                <Skeleton className="h-80 w-full" />
            )}

            {listing ? (
                <p className="text-[0.6875rem] text-muted-foreground">
                    {t("terminal.sessions.keepsRunning", { minutes: listing.idleMinutes })}
                </p>
            ) : null}
        </div>
    );
}

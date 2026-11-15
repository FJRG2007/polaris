"use client";

/**
 * The account a running Code session signs in with, beside the composer, and a
 * dialog to move it to another of its owner's accounts for the same tool. The
 * pick shows at once and goes back if the server refuses it; the next turn
 * runs on the new account and resumes the same conversation.
 */

import { Check, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    cn
} from "@polaris/ui";
import { fromWire } from "@/lib/app-bundles/wire";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { SessionAccountChoice } from "@/components/agents/sessions/actions";

interface Accounts {
    readonly current: string | null;
    readonly accounts: readonly SessionAccountChoice[];
}

/** The last list each session drew, so reopening the thread shows it at once. */
const cache = new Map<string, Accounts>();
const CACHE_MOST = 50;

async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    const answer = (await response.json()) as { value?: unknown };
    return fromWire(answer.value) as T;
}

function remember(sessionId: string, value: Accounts): void {
    cache.delete(sessionId);
    cache.set(sessionId, value);
    if (cache.size > CACHE_MOST) cache.delete(cache.keys().next().value!);
}

export function CodeAccountSwitch({
    sessionId,
    disabled = false,
    onSwitched,
    onError
}: {
    sessionId: string;
    disabled?: boolean;
    /** The thread reads itself again, so the switch notice shows. */
    onSwitched: () => void;
    onError: (message: string | null) => void;
}) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const [state, setState] = useState<Accounts | null>(() => cache.get(sessionId) ?? null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    const load = useCallback(() => {
        setFailed(false);
        void post<Accounts | { error: string } | null>("/api/polar/code/accounts", { sessionId })
            .then((answer) => {
                if (!answer || "error" in answer) {
                    setState(null);
                    return;
                }
                remember(sessionId, answer);
                setState(answer);
            })
            .catch(() => setFailed(true));
    }, [sessionId]);

    useEffect(() => {
        setState(cache.get(sessionId) ?? null);
        load();
    }, [sessionId, load]);

    const others = state ? state.accounts.filter((account) => account.id !== state.current) : [];
    if (!state || others.length === 0) return null;
    const current = state.accounts.find((account) => account.id === state.current) ?? null;

    const pick = (id: string) => {
        if (id === state.current || saving) return;
        const before = state;
        const after = { ...state, current: id };
        // Shown at once; put back if the server says no.
        setState(after);
        remember(sessionId, after);
        setSaving(true);
        onError(null);
        void post<{ error?: string }>("/api/polar/code/account", { sessionId, accountId: id })
            .then((answer) => {
                if (answer?.error) throw new Error(answer.error);
                setOpen(false);
                onSwitched();
            })
            .catch((error: unknown) => {
                setState(before);
                remember(sessionId, before);
                const message = error instanceof Error && !error.message.startsWith("/api/") ? error.message : null;
                onError(message ?? t("session.account.errors.failed"));
            })
            .finally(() => setSaving(false));
    };

    return (
        <>
            <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 min-w-0 max-w-48 gap-1.5 px-2 text-xs"
                disabled={disabled}
                aria-label={t("session.account.title")}
                title={current?.name ?? t("session.account.button")}
                onClick={() => {
                    setOpen(true);
                    load();
                }}
            >
                <UserRound className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{current?.name ?? t("session.account.button")}</span>
            </Button>
            <Dialog open={open} onOpenChange={(next) => (saving ? undefined : setOpen(next))}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("session.account.title")}</DialogTitle>
                        <DialogDescription>{t("session.account.intro")}</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t("session.account.title")}>
                        {state.accounts.map((account) => {
                            const on = account.id === state.current;
                            return (
                                <button
                                    key={account.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    disabled={saving}
                                    onClick={() => pick(account.id)}
                                    className={cn(
                                        "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                                        on ? "border-primary bg-primary/5" : "hover:bg-muted",
                                        saving && "opacity-60"
                                    )}
                                >
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="min-w-0 truncate" title={account.name}>
                                            {account.name}
                                        </span>
                                        {account.coolingUntil ? (
                                            <span className="text-xs text-muted-foreground">
                                                {t("session.account.cooling", {
                                                    at: format.dateTime(account.coolingUntil)
                                                })}
                                            </span>
                                        ) : null}
                                    </span>
                                    {on ? (
                                        <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
                                            <Check className="size-3.5 shrink-0" aria-hidden />
                                            {t("session.account.current")}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                    {failed ? <p className="text-xs text-destructive">{t("session.account.loadFailed")}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>
                            {t("session.account.cancel")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

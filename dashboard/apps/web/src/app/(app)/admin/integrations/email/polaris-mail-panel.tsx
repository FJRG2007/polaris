"use client";

/**
 * The "Polaris mail server" choice in the Add sender dialog: no form, because the
 * server makes its own sender. What it shows is the one step between here and
 * sending - turn the app on, set a server up, or create the sender on a server
 * that is ready - with the button that takes it.
 *
 * Creating the sender runs in the background on the server, so the panel checks
 * again every few seconds for a bounded while and hands the new sender's arrival
 * to the page.
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { polarisMailStateAction, type PolarisMailState } from "./mail-server-sender";
import { installMailServerAppAction, resumeSetupAction } from "@/app/(app)/mail-server/actions";

/** How often, and how many times, to look for the sender a server is creating. */
const POLL_MS = 3000;
const POLL_TRIES = 20;

export function PolarisMailPanel({ onSending }: { onSending: () => void }) {
    const t = useTranslations("admin");
    const [state, setState] = useState<PolarisMailState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [waiting, setWaiting] = useState(false);
    const [busy, start] = useTransition();
    const alive = useRef(true);

    const load = useCallback(async (): Promise<PolarisMailState | null> => {
        try {
            const next = await polarisMailStateAction();
            if (alive.current) setState(next);
            return next;
        } catch {
            if (alive.current) setError(t("email.polarisMail.loadFailed"));
            return null;
        }
    }, [t]);

    useEffect(() => {
        alive.current = true;
        void load();
        return () => {
            alive.current = false;
        };
    }, [load]);

    function retry() {
        setError(null);
        setState(null);
        void load();
    }

    function enable() {
        setError(null);
        start(async () => {
            const result = await installMailServerAppAction();
            if (result.error) setError(result.error);
            else await load();
        });
    }

    function sendThrough(serverId: string) {
        setError(null);
        start(async () => {
            const result = await resumeSetupAction({ serverId, from: "sender" });
            if (result.error) {
                setError(result.error);
                return;
            }
            setWaiting(true);
            for (let attempt = 0; attempt < POLL_TRIES && alive.current; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
                const next = await load();
                if (next?.kind === "sending") {
                    onSending();
                    break;
                }
                if (next?.kind === "failed") break;
            }
            if (alive.current) setWaiting(false);
        });
    }

    if (!state && !error) {
        return (
            <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-9 w-40" />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3 text-sm">
            {state ? <StateBody state={state} waiting={waiting} /> : null}
            {error ? <p className="text-danger">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
                {!state ? (
                    <Button type="button" variant="secondary" onClick={retry}>
                        {t("email.polarisMail.retry")}
                    </Button>
                ) : state.kind === "not-installed" && state.canInstall ? (
                    <Button type="button" onClick={enable} disabled={busy}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("email.polarisMail.enable")}
                    </Button>
                ) : state.kind === "no-server" ? (
                    <Button asChild>
                        <Link href="/mail-server">{t("email.polarisMail.setUp")}</Link>
                    </Button>
                ) : state.kind === "ready" && !waiting ? (
                    <Button type="button" onClick={() => sendThrough(state.serverId)} disabled={busy}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("email.polarisMail.use", { host: state.hostname })}
                    </Button>
                ) : state.kind === "setting-up" || state.kind === "failed" || state.kind === "sending" ? (
                    <Button asChild variant="secondary">
                        <Link href={`/mail-server/${state.serverId}`}>{t("email.polarisMail.open")}</Link>
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

function StateBody({ state, waiting }: { state: PolarisMailState; waiting: boolean }) {
    const t = useTranslations("admin");
    const text = (() => {
        switch (state.kind) {
            case "forbidden":
                return t("email.polarisMail.forbidden");
            case "not-installed":
                return t(state.canInstall ? "email.polarisMail.notInstalled" : "email.polarisMail.notInstalledAsk");
            case "no-server":
                return t("email.polarisMail.noServer");
            case "setting-up":
                return t("email.polarisMail.settingUp", { host: state.hostname });
            case "failed":
                return t("email.polarisMail.failed", { host: state.hostname });
            case "ready":
                return waiting
                    ? t("email.polarisMail.starting", { host: state.hostname })
                    : t("email.polarisMail.ready", { host: state.hostname });
            case "sending":
                return t("email.polarisMail.sending", { host: state.hostname, name: state.channelName });
        }
    })();
    return <p className="text-muted-foreground">{text}</p>;
}

"use client";

/**
 * "Connect locally" for a Nuki account: start the broker on this machine, show
 * exactly what to type into the Nuki app, and say the moment each lock appears
 * on it. The locks stay the account's own devices; nothing is added twice.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
    Button,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";
import * as actions from "../actions";
import { usePlacesT } from "../use-places-t";
import type { LocalLinkState } from "../../lib/local-broker";
import type { DeviceAccountView } from "../../lib/device-accounts";

/** How often the dialog asks the broker who is on it while it is open. */
const WATCH_MS = 3000;

export function NukiLocalDialog({
    account,
    onClose
}: {
    account: DeviceAccountView | null;
    onClose: () => void;
}) {
    const t = usePlacesT();
    const [state, setState] = useState<LocalLinkState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const accountId = account?.id ?? null;

    useEffect(() => {
        setState(null);
        setError(null);
        if (!accountId) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const look = async () => {
            const result = await actions.nukiLocalStateAction(accountId).catch(() => null);
            if (stopped) return;
            if (result?.error) setError(result.error);
            else if (result?.state) setState(result.state);
            timer = setTimeout(() => void look(), WATCH_MS);
        };
        void look();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [accountId]);

    async function start() {
        if (!accountId) return;
        setStarting(true);
        setError(null);
        const result = await actions.linkNukiLocallyAction(accountId);
        setStarting(false);
        if (result.error) setError(result.error);
        else if (result.state) setState(result.state);
    }

    const broker = state?.broker ?? null;
    const fields = broker
        ? [
              { label: t("nukiLocal.host"), value: broker.host },
              { label: t("nukiLocal.port"), value: String(broker.port) },
              { label: t("nukiLocal.username"), value: broker.username },
              { label: t("nukiLocal.password"), value: broker.password }
          ]
        : [];
    const connected = state?.devices.filter((device) => device.connected) ?? [];

    return (
        <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("nukiLocal.title")}</DialogTitle>
                    <DialogDescription>{t("nukiLocal.intro")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-4 text-sm">
                    {!state?.linked ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-foreground-subtle">{t("nukiLocal.startHint")}</p>
                            <Button
                                onClick={() => void start()}
                                disabled={starting || (!state && !error)}
                            >
                                {starting && <Loader2 className="size-4 shrink-0 animate-spin" />}
                                {starting ? t("nukiLocal.starting") : t("nukiLocal.start")}
                            </Button>
                        </div>
                    ) : (
                        <>
                            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
                                <li>{t("nukiLocal.steps.s0")}</li>
                                <li>{t("nukiLocal.steps.s1")}</li>
                                <li>{t("nukiLocal.steps.s2")}</li>
                                <li>{t("nukiLocal.steps.s3")}</li>
                            </ol>
                            <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
                                {fields.map((field) => (
                                    <div key={field.label} className="contents">
                                        <dt className="text-foreground-subtle">{field.label}</dt>
                                        <dd
                                            className="min-w-0 truncate font-mono"
                                            title={field.value}
                                        >
                                            {field.value}
                                        </dd>
                                        <CopyButton value={field.value} label={field.label} />
                                    </div>
                                ))}
                            </dl>
                            <ul className="flex flex-col gap-1">
                                {state.devices.map((device) => (
                                    <li key={device.id} className="flex min-w-0 items-center gap-2">
                                        {device.connected ? (
                                            <CheckCircle2 className="size-4 shrink-0 text-success" />
                                        ) : (
                                            <Loader2 className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                                        )}
                                        <span className="min-w-0 truncate" title={device.name}>
                                            {device.name}
                                        </span>
                                        <span className="shrink-0 text-xs text-foreground-subtle">
                                            {device.connected
                                                ? t("nukiLocal.connected")
                                                : t("nukiLocal.waiting", { id: device.nukiId })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            {!state.reachable && (
                                <p className="text-destructive">{t("nukiLocal.unreachable")}</p>
                            )}
                            {connected.length > 0 && (
                                <p className="text-foreground-subtle">{t("nukiLocal.fallback")}</p>
                            )}
                        </>
                    )}
                    {error && <p className="text-destructive">{error}</p>}
                </div>
            </DialogContent>
        </Dialog>
    );
}

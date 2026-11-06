"use client";

/**
 * Says so when deleted servers left DNS records the provider would not remove.
 *
 * Fetched after the list paints: it is rarely there, and the table must not wait
 * for a question that is almost always answered with nothing. Polaris retries on
 * its own every hour; the button only saves waiting for it.
 */

import { Button } from "@polaris/ui";
import { useGameText } from "./game-text";
import { Globe, Loader2 } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { gameDnsLeftoversAction, retryGameDnsLeftoversAction } from "./actions";

type Leftovers = Awaited<ReturnType<typeof gameDnsLeftoversAction>>;

export function DnsLeftoversNotice() {
    const t = useGameText("games");
    const [leftovers, setLeftovers] = useState<Leftovers>(null);
    const [failed, setFailed] = useState(false);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let live = true;
        gameDnsLeftoversAction()
            .then((value) => live && setLeftovers(value))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);

    if (!leftovers) return null;

    const retry = () =>
        startTransition(async () => {
            try {
                setLeftovers(await retryGameDnsLeftoversAction());
                setFailed(false);
            } catch {
                setFailed(true);
            }
        });

    return (
        <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2"
        >
            <Globe className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                <p className="font-medium text-foreground">
                    {t("dnsLeftovers.title", { count: leftovers.count })}
                </p>
                <p className="break-words text-muted-foreground">
                    {leftovers.noToken
                        ? t("dnsLeftovers.noToken")
                        : leftovers.reason
                          ? t("dnsLeftovers.reason", { reason: leftovers.reason })
                          : t("dnsLeftovers.refused")}
                </p>
                {failed && <p className="text-danger">{t("dnsLeftovers.retryFailed")}</p>}
            </div>
            <Button size="sm" variant="secondary" onClick={retry} disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {t("dnsLeftovers.retry")}
            </Button>
        </div>
    );
}

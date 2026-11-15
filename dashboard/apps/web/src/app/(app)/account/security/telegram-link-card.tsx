"use client";

/**
 * Linking Telegram for verification codes.
 *
 * A bot cannot write to somebody who never opened it, so linking opens the
 * deployment's bot with a one-time start link; pressing Start there is what
 * binds the chat. The card then checks every few seconds until the press
 * arrives or the link runs out. Hidden while the deployment has no Telegram
 * code sender - the methods list above already says so.
 */

import { useRouter } from "next/navigation";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button, Card, CardBody } from "@polaris/ui";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TwoFactorMethodStatus } from "@/lib/two-factor-delivery";
import { checkTelegramLinkAction, startTelegramLinkAction, unlinkTelegramAction } from "./two-factor-actions";

const CHECK_EVERY_MS = 3_000;
/** Matches the link's lifetime on the server. */
const CHECK_FOR_MS = 10 * 60 * 1000;
const NOT_LINKED = "Link your Telegram account first.";

export function TelegramLinkCard({ status, locked }: { status: TwoFactorMethodStatus | undefined; locked: boolean }) {
    const t = useTranslations("accountSecurity");
    const router = useRouter();
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, startBusy] = useTransition();

    useEffect(() => {
        if (!url) return;
        const until = Date.now() + CHECK_FOR_MS;
        const timer = setInterval(() => {
            if (Date.now() > until) {
                clearInterval(timer);
                setUrl(null);
                setError(t("telegram.expired"));
                return;
            }
            void checkTelegramLinkAction().then((result) => {
                if (result.linked) {
                    clearInterval(timer);
                    setUrl(null);
                    router.refresh();
                } else if (result.error) {
                    clearInterval(timer);
                    setUrl(null);
                    setError(result.error);
                }
            });
        }, CHECK_EVERY_MS);
        return () => clearInterval(timer);
    }, [url, router, t]);

    if (!status || (!status.available && status.blocker !== NOT_LINKED)) return null;
    const linked = status.available;

    function start() {
        setError(null);
        startBusy(async () => {
            const result = await startTelegramLinkAction();
            if (result.error || !result.url) return setError(result.error ?? t("telegram.failed"));
            setUrl(result.url);
            window.open(result.url, "_blank", "noopener,noreferrer");
        });
    }

    function unlink() {
        setError(null);
        startBusy(async () => {
            const result = await unlinkTelegramAction();
            if (result.error) return setError(result.error);
            router.refresh();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("telegram.title")}</h2>
                        <p className="text-xs text-muted-foreground">
                            {linked ? t("telegram.linked") : t("telegram.description")}
                        </p>
                    </div>
                    {linked ? (
                        <Button variant="outline" size="sm" disabled={locked || busy} onClick={unlink}>
                            {t("telegram.unlink")}
                        </Button>
                    ) : (
                        <Button size="sm" disabled={locked || busy} onClick={start}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("telegram.link")}
                        </Button>
                    )}
                </div>
                {url ? (
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t("telegram.waiting")}
                        <a className="inline-flex items-center gap-1 underline" href={url} target="_blank" rel="noopener noreferrer">
                            {t("telegram.open")} <ExternalLink className="size-3" />
                        </a>
                    </p>
                ) : null}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

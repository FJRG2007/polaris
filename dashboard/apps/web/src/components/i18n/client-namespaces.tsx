"use client";

/**
 * `Messages` for a client screen drawn where no server layout of ours hands it
 * its namespaces - an installable app's route embedding a dashboard screen. The
 * namespaces are fetched once per tab and language and kept, so drawing it again
 * waits for nothing; until they arrive the fallback stands in.
 */

import { Button } from "@polaris/ui";
import type { Namespaces } from "@polaris/core";
import { useEffect, useState, type ReactNode } from "react";

import { MessagesProvider, useLocale, useTranslations } from "./i18n-provider";
import * as polls from "../shared-polls";

/** The namespaces the action hands out; anything else it refuses. */
type Askable = readonly "automations"[];

const kept = new Map<string, Namespaces>();

export function ClientMessages({
    namespaces,
    fallback,
    children
}: {
    namespaces: Askable;
    fallback: ReactNode;
    children: ReactNode;
}) {
    const locale = useLocale();
    const key = `${locale}:${namespaces.join(",")}`;
    const t = useTranslations("common");
    const [messages, setMessages] = useState<Namespaces | null>(() => kept.get(key) ?? null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const ready = kept.get(key);
        if (ready) {
            setMessages(ready);
            return;
        }
        let cancelled = false;
        setFailed(false);
        void polls
            .namespaceMessages([...namespaces])
            .then((answer) => {
                if (cancelled) return;
                if (!answer) {
                    setFailed(true);
                    return;
                }
                kept.set(`${answer.locale}:${namespaces.join(",")}`, answer.messages);
                setMessages(answer.messages);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
        // The key names the namespaces; the array itself is a new one each render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, attempt]);

    if (!messages && failed) {
        return (
            <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground"
            >
                <span className="min-w-0 flex-1">{t("share.unreadable")}</span>
                <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                    {t("pages.error.tryAgain")}
                </Button>
            </div>
        );
    }
    if (!messages) return <>{fallback}</>;
    return <MessagesProvider messages={messages}>{children}</MessagesProvider>;
}

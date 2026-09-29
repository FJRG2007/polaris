"use client";

/**
 * Live messaging log: recent message events across every channel, newest first,
 * short-polled like the rest of the Inbox. Shows direction, channel, peer, the
 * text, and outbound delivery state.
 */

import { Card, CardBody } from "@polaris/ui";
import { listActivityAction } from "../actions";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { ActivityView } from "@/lib/messaging-service";
import { useTranslations } from "@/components/i18n/i18n-provider";

const PLATFORM_LABEL: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack"
};

function ackTone(ack: string | null): string {
    if (ack === "failed") return "text-danger";
    if (ack === "sent" || ack === "delivered" || ack === "read") return "text-success";
    return "text-muted-foreground";
}

/** Deterministic timestamp (no locale) so SSR and client hydration agree. */
function stamp(iso: string): string {
    return iso.slice(0, 19).replace("T", " ");
}

export function LogsView({ initialActivity }: { initialActivity: ActivityView[] }) {
    const t = useTranslations("admin");
    const [activity, setActivity] = useState(initialActivity);

    const load = useCallback(() => {
        void listActivityAction()
            .then(setActivity)
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
    }, [load]);

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("inboxLogs.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("inboxLogs.intro")}</p>
            </div>
            <Card>
                <CardBody className="p-0">
                    {activity.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">{t("inboxLogs.empty")}</p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {activity.map((item) => {
                                const outbound = item.direction === "outbound";
                                const Arrow = outbound ? ArrowUpRight : ArrowDownLeft;
                                return (
                                    <li key={item.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                                        <Arrow
                                            className={`mt-0.5 size-4 shrink-0 ${
                                                outbound ? "text-primary" : "text-muted-foreground"
                                            }`}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate">
                                                <span className="font-medium">{item.peer}</span>
                                                <span className="text-muted-foreground">
                                                    {" - "}
                                                    {item.body ?? item.selection ?? t("inboxLogs.noText")}
                                                </span>
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {PLATFORM_LABEL[item.platform] ?? item.platform} / {item.channelName}
                                                {" - "}
                                                {stamp(item.createdAt)}
                                                {outbound && item.ack ? (
                                                    <span className={`ml-1 ${ackTone(item.ack)}`}>
                                                        - {t("inboxLogs.ack", { ack: item.ack })}
                                                    </span>
                                                ) : null}
                                            </p>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}

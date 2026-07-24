"use client";

/**
 * Live messaging log: recent message events across every channel, newest first,
 * short-polled like the rest of the Inbox. Shows direction, channel, peer, the
 * text, and outbound delivery state.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Card, CardBody } from "@polaris/ui";
import type { ActivityView } from "@/lib/messaging-service";
import { listActivityAction } from "../actions";

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
        <div className="flex max-w-4xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Logs</h1>
                <p className="text-sm text-muted-foreground">
                    Recent messages across every channel - inbound, outbound, and delivery state. Updates live.
                </p>
            </div>
            <Card>
                <CardBody className="p-0">
                    {activity.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">No messaging activity yet.</p>
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
                                                    {item.body ?? item.selection ?? "(no text)"}
                                                </span>
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {PLATFORM_LABEL[item.platform] ?? item.platform} / {item.channelName}
                                                {" - "}
                                                {stamp(item.createdAt)}
                                                {outbound && item.ack ? (
                                                    <span className={`ml-1 ${ackTone(item.ack)}`}>- {item.ack}</span>
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

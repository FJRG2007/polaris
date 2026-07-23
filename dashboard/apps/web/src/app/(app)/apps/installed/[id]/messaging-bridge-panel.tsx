"use client";

/**
 * Adapted dashboard for an installed Messaging bridge. The bridge itself needs no
 * per-app config; credentials are set per channel when connecting it in the Inbox
 * (a Telegram/Discord/Slack bot token, a WhatsApp Cloud token + phone-number id,
 * or a WhatsApp QR scan). This panel surfaces the connected channels and their
 * live status, and sends the operator to the Inbox to add or manage them.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Hash, Loader2, MessageCircle, MessagesSquare, Plus, Send, Slack, type LucideIcon } from "lucide-react";
import { Badge, Button, Card, CardBody, cn } from "@polaris/ui";
import { inboxStateAction } from "@/app/(app)/inbox/actions";
import type { ChannelView } from "@/lib/messaging-service";

/** A neutral glyph + label per platform (no third-party brand logos). */
const PLATFORM: Record<string, { icon: LucideIcon; label: string }> = {
    telegram: { icon: Send, label: "Telegram" },
    whatsapp: { icon: MessageCircle, label: "WhatsApp" },
    discord: { icon: Hash, label: "Discord" },
    slack: { icon: Slack, label: "Slack" }
};

const STATUS_TONE: Record<string, string> = {
    connected: "border-success/40 text-success",
    connecting: "border-warning/40 text-warning",
    error: "border-danger/40 text-danger",
    disconnected: "border-danger/40 text-danger"
};

function platformLabel(channel: ChannelView): string {
    const base = PLATFORM[channel.platform]?.label ?? channel.platform;
    return channel.provider === "whatsapp-cloud" ? `${base} Cloud` : base;
}

export function MessagingBridgePanel() {
    const [channels, setChannels] = useState<ChannelView[] | null>(null);

    useEffect(() => {
        let active = true;
        void inboxStateAction()
            .then((state) => active && setChannels(state.channels))
            .catch(() => active && setChannels([]));
        return () => {
            active = false;
        };
    }, []);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-sm font-medium">Channels</p>
                        <p className="text-xs text-muted-foreground">
                            Connect WhatsApp, Telegram, Discord or Slack. Each channel's token, phone number or QR is
                            entered in the Inbox when you connect it.
                        </p>
                    </div>
                    <Button asChild size="sm">
                        <Link href="/inbox">
                            <Plus className="size-4" /> Connect a channel
                        </Link>
                    </Button>
                </div>

                {channels === null ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading channels...
                    </div>
                ) : channels.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border py-8 text-center">
                        <MessagesSquare className="size-6 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            No channels connected yet. Connect one to start receiving and sending messages from the Inbox.
                        </p>
                        <Button asChild size="sm" variant="secondary">
                            <Link href="/inbox">Go to the Inbox</Link>
                        </Button>
                    </div>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {channels.map((channel) => {
                            const Icon = PLATFORM[channel.platform]?.icon ?? MessagesSquare;
                            return (
                                <li key={channel.id} className="flex items-center gap-3 py-2.5">
                                    <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface">
                                        <Icon className="size-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{channel.name}</p>
                                        <p className="text-xs text-muted-foreground">{platformLabel(channel)}</p>
                                    </div>
                                    <Badge className={cn(STATUS_TONE[channel.status])}>{channel.status}</Badge>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {channels && channels.length > 0 && (
                    <Link href="/inbox" className="text-sm text-primary hover:underline">
                        Open the Inbox
                    </Link>
                )}
            </CardBody>
        </Card>
    );
}

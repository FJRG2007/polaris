"use client";

/**
 * Adapted dashboard for an installed Messaging bridge. The bridge itself needs no
 * per-app config; credentials are set per channel when connecting it in the Inbox
 * (a Telegram/Discord/Slack bot token, a WhatsApp Cloud token + phone-number id,
 * or a WhatsApp QR scan). This panel surfaces the connected channels and their
 * live status, and sends the operator to the Inbox to add or manage them.
 */

import { useCallback } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import Link from "next/link";
import {
    Hash,
    Loader2,
    MessageCircle,
    MessagesSquare,
    Plus,
    Send,
    Slack,
    type LucideIcon
} from "lucide-react";
import { Badge, Button, Card, CardBody, cn } from "@polaris/ui";
import { inboxStateAction } from "@/app/(app)/admin/inbox/actions";
import type { ChannelView } from "@/lib/messaging-service";

/** A neutral glyph + label per platform (no third-party brand logos). The
 *  labels are the products' own names, the same in every language. */
const PLATFORM: Record<string, { icon: LucideIcon; label: string }> = {
    telegram: { icon: Send, label: "Telegram" }, // i18n-ignore
    whatsapp: { icon: MessageCircle, label: "WhatsApp" }, // i18n-ignore
    discord: { icon: Hash, label: "Discord" }, // i18n-ignore
    slack: { icon: Slack, label: "Slack" } // i18n-ignore
};

const STATUS_TONE: Record<string, string> = {
    connected: "border-success-edge text-success",
    connecting: "border-warning-edge text-warning",
    error: "border-danger-edge text-danger", // i18n-ignore: a class list
    disconnected: "border-danger-edge text-danger"
};

function platformLabel(channel: ChannelView): string {
    const base = PLATFORM[channel.platform]?.label ?? channel.platform;
    return channel.provider === "whatsapp-cloud" ? `${base} Cloud` : base;
}

/** The statuses there are words for; anything newer is shown as it came. */
const STATUSES = new Set(["connected", "connecting", "error", "disconnected"]);

export function MessagingBridgePanel() {
    const t = useTranslations("installed");
    // The channels as this tab last saw them paint at once; the fresh list replaces
    // only what moved. Names and statuses only - no channel's token is in it.
    const load = useCallback(
        () =>
            inboxStateAction()
                .then((state) => state.channels)
                .catch((): ChannelView[] => []),
        []
    );
    const { data: channels } = useLiveRead<ChannelView[]>({
        load,
        cacheKey: "installed.messaging-channels"
    });

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-sm font-medium">{t("channels.title")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("channels.hint")}
                        </p>
                    </div>
                    <Button asChild size="sm">
                        <Link href="/admin/inbox">
                            <Plus className="size-4" /> {t("channels.connect")}
                        </Link>
                    </Button>
                </div>

                {channels === null ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> {t("channels.loading")}
                    </div>
                ) : channels.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border py-8 text-center">
                        <MessagesSquare className="size-6 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            {t("channels.empty")}
                        </p>
                        <Button asChild size="sm" variant="secondary">
                            <Link href="/admin/inbox">{t("channels.goToInbox")}</Link>
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
                                        <p className="truncate text-sm font-medium">
                                            {channel.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {platformLabel(channel)}
                                        </p>
                                    </div>
                                    <Badge className={cn(STATUS_TONE[channel.status])}>
                                        {STATUSES.has(channel.status)
                                            ? t(
                                                  `channels.status.${channel.status as "connected" | "connecting" | "error" | "disconnected"}`
                                              )
                                            : channel.status}
                                    </Badge>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {channels && channels.length > 0 && (
                    <Link href="/admin/inbox" className="text-sm text-primary hover:underline">
                        {t("channels.openInbox")}
                    </Link>
                )}
            </CardBody>
        </Card>
    );
}

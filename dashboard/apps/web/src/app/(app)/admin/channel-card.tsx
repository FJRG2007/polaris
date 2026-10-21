"use client";

/**
 * The card a connected channel is listed on: the Inbox's messaging channels and
 * the email senders on Email & SMS.
 */

import type { ComponentType } from "react";
import { CheckCircle2, Settings2 } from "lucide-react";
import { Badge, Button, Card, CardBody, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CHANNEL_STATUS_TONE } from "./inbox/platform-meta";

/** One connected channel, whatever it carries. A messaging channel and an email
 *  sender differ only in what their subtitle says, so they share a card. */
export function ChannelCard({
    Logo,
    color,
    name,
    status,
    statusLabel,
    detail,
    error,
    ready,
    onManage
}: {
    Logo: ComponentType<{ className?: string }>;
    color?: string;
    name: string;
    status: string;
    statusLabel: string;
    detail: string;
    /** Why the last check or send failed, when it did. */
    error?: string | null;
    /** The line shown when the channel is working, or null when it is not. */
    ready: string | null;
    onManage: () => void;
}) {
    const t = useTranslations("admin");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div
                        className="grid size-10 shrink-0 place-items-center rounded-md"
                        style={{ color, backgroundColor: color ? `${color}1a` : undefined }}
                    >
                        <Logo className="size-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h2 className="truncate text-sm font-medium">{name}</h2>
                            <Badge className={cn(CHANNEL_STATUS_TONE[status])}>{statusLabel}</Badge>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
                    </div>
                </div>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <div className="flex items-center justify-end gap-2">
                    {ready ? (
                        <span className="mr-auto inline-flex items-center gap-1 text-xs text-success">
                            <CheckCircle2 className="size-3.5" /> {ready}
                        </span>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={onManage}>
                        <Settings2 className="size-4" /> {t("inboxChannels.manage.button")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

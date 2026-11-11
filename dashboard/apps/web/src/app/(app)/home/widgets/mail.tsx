"use client";

/**
 * The Overview's Mail card: how much is unread in the reader's own inboxes -
 * the number the badge shows - and the newest of it, each opening its
 * conversation.
 */

import Link from "next/link";
import type { Loaded } from "./infrastructure";
import type { OverviewMail } from "@/lib/overview/overview-service";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    WidgetEmpty,
    WidgetList,
    WidgetRow,
    WidgetRowsSkeleton,
    WidgetUnavailable
} from "../widget-card";

export function MailWidget({ data }: { data: Loaded<OverviewMail> }) {
    const t = useTranslations("home");
    if (data === undefined) return <WidgetRowsSkeleton />;
    if (data === null) return <WidgetUnavailable>{t("mail.unavailable")}</WidgetUnavailable>;
    if (data.unread === 0 || data.messages.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link href="/mail" className="text-xs font-medium text-primary hover:underline">
                        {t("mail.open")}
                    </Link>
                }
            >
                {t("mail.empty")}
            </WidgetEmpty>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm">
                {t.rich("mail.unread", {
                    big: (chunks) => (
                        <span key="big" className="text-xl font-semibold tabular-nums">
                            {chunks}
                        </span>
                    ),
                    rest: (chunks) => (
                        <span key="rest" className="text-muted-foreground">
                            {chunks}
                        </span>
                    ),
                    count: data.unread
                })}
            </p>
            <WidgetList>
                {data.messages.map((message) => (
                    <WidgetRow
                        key={`${message.threadId}:${message.at}`}
                        href={message.href}
                        label={message.subject || t("mail.noSubject")}
                        detail={message.from || t("mail.unknownSender")}
                        trailing={
                            <span className="shrink-0 text-xs text-muted-foreground">
                                <RelativeTime iso={message.at} />
                            </span>
                        }
                    />
                ))}
            </WidgetList>
        </div>
    );
}

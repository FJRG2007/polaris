"use client";

/**
 * The two halves of the notifications page: what arrived, and where it goes.
 * They are tabs rather than two pages because the answer to "why did nobody tell
 * me" is nearly always one click away from the alert that did not arrive.
 */

import type { NotificationHolds, QuietHours } from "@polaris/core";
import { useState } from "react";
import { Bell, SlidersHorizontal } from "lucide-react";
import { cn } from "@polaris/ui";
import type { NotificationRule } from "@polaris/core";
import type { DeliveryView } from "@/lib/notification-service";
import type { DestinationView } from "@/lib/notifications/destinations";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import type { InGameChoice } from "@/lib/chat/in-game-choice";
import { NotificationsView } from "./notifications-view";
import { NotificationSettingsView } from "./notification-settings-view";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat } from "@/components/display-format";
import type { DoNotDisturbView } from "@/lib/presence-service";

export function NotificationsPageView({
    rules,
    destinations,
    senders,
    deliveries,
    messagesInGame,
    inGameReady = true,
    badgesClearOnVisit = null,
    quiet = null,
    paused = null,
    holds,
    timeZone
}: {
    rules: Array<{ event: string; rule: NotificationRule }>;
    destinations: DestinationView[];
    senders: SmsSenderView[];
    deliveries: DeliveryView[];
    /** Which Chat messages are shown inside a game, or null where no app can. */
    messagesInGame: InGameChoice | null;
    /** Whether a server knows which of its players this account is. */
    inGameReady?: boolean;
    /** Whether opening a screen clears its badge, or null for nobody with one. */
    badgesClearOnVisit?: boolean | null;
    /** Quiet hours and the zone they are read in; null leaves the card out. */
    quiet?: { hours: QuietHours; timeZone: string } | null;
    /** Do not disturb as it stands when the page opened, or null when off. */
    paused?: DoNotDisturbView | null;
    /** Mutes and schedules per event or group. */
    holds?: NotificationHolds;
    /** The zone schedules are read in. */
    timeZone?: string;
}) {
    const [tab, setTab] = useState<"history" | "settings">("history");
    const t = useTranslations("accountNotifications");
    const format = useDisplayFormat();
    // The time alone when it ends today, the date with it otherwise.
    const untilLabel = (until: string) => {
        const at = new Date(until);
        return format.date(at) === format.date(new Date()) ? format.time(at) : format.dateTime(at);
    };

    const tabs = [
        { id: "history" as const, label: t("tabs.history"), icon: Bell },
        { id: "settings" as const, label: t("tabs.delivery"), icon: SlidersHorizontal }
    ];

    return (
        <div className="flex flex-col gap-4">
            {paused?.on ? (
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                    <p className="font-medium">
                        {paused.until
                            ? t("dnd.pausedUntil", { time: untilLabel(paused.until) })
                            : t("dnd.paused")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {paused.reason ? `${t(`dnd.${paused.reason}`)} ` : ""}
                        {t("dnd.critical")}
                    </p>
                </div>
            ) : null}
            <div className="flex gap-1 border-b border-border">
                {tabs.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => setTab(entry.id)}
                        className={cn(
                            "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                            tab === entry.id
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <entry.icon className="size-4" />
                        {entry.label}
                    </button>
                ))}
            </div>

            {tab === "history" ? <NotificationsView /> : null}
            {tab === "settings" ? (
                <NotificationSettingsView
                    rules={rules}
                    destinations={destinations}
                    senders={senders}
                    deliveries={deliveries}
                    messagesInGame={messagesInGame}
                    inGameReady={inGameReady}
                    badgesClearOnVisit={badgesClearOnVisit}
                    quiet={quiet}
                    holds={holds}
                    timeZone={timeZone}
                />
            ) : null}
        </div>
    );
}

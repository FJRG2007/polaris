"use client";

/**
 * The two halves of the notifications page: what arrived, and where it goes.
 * They are tabs rather than two pages because the answer to "why did nobody tell
 * me" is nearly always one click away from the alert that did not arrive.
 */

import { useState } from "react";
import { Bell, SlidersHorizontal } from "lucide-react";
import { cn } from "@polaris/ui";
import type { NotificationRule } from "@polaris/core";
import type { DeliveryView } from "@/lib/notification-service";
import type { DestinationView } from "@/lib/notifications/destinations";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import { NotificationsView } from "./notifications-view";
import { NotificationSettingsView } from "./notification-settings-view";

export function NotificationsPageView({
    rules,
    destinations,
    senders,
    deliveries
}: {
    rules: Array<{ event: string; rule: NotificationRule }>;
    destinations: DestinationView[];
    senders: SmsSenderView[];
    deliveries: DeliveryView[];
}) {
    const [tab, setTab] = useState<"history" | "settings">("history");

    const tabs = [
        { id: "history" as const, label: "History", icon: Bell },
        { id: "settings" as const, label: "Delivery", icon: SlidersHorizontal }
    ];

    return (
        <div className="flex flex-col gap-4">
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
                />
            ) : null}
        </div>
    );
}

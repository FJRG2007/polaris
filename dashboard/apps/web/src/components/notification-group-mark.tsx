"use client";

/**
 * A notification group's mark beside its name: the app's own logo for an app's
 * alerts, the Polaris star for Polaris's own, and a shield for security, which
 * no single app raises. Every branch holds the same square box, so a column of
 * groups stays aligned. Decorative, as the group's name is written beside it.
 */

import { ShieldCheck } from "lucide-react";
import { PolarisStar, cn } from "@polaris/ui";
import type { NotificationGroup } from "@polaris/core";
import { PolarisAppIcon } from "@/components/polaris-app-icon";
import { notificationGroupMark } from "@/lib/notifications/group-apps";

export function NotificationGroupMark({
    group,
    label,
    size = 16,
    className
}: {
    group: NotificationGroup;
    /** The group's name, for the initial an app without a logo falls back to. */
    label?: string;
    size?: number;
    className?: string;
}) {
    const mark = notificationGroupMark(group);
    if (mark.kind === "app") {
        return <PolarisAppIcon appId={mark.appId} label={label} size={size} className={className} />;
    }
    return (
        <span
            aria-hidden="true"
            data-group-mark={mark.kind}
            className={cn("inline-grid shrink-0 place-items-center", className)}
            style={{ width: size, height: size }}
        >
            {mark.kind === "polaris" ? (
                <PolarisStar className="size-full text-primary" />
            ) : (
                <ShieldCheck className="size-full text-muted-foreground" />
            )}
        </span>
    );
}

"use client";

/**
 * The thing drawn to the left of an alert.
 *
 * A severity icon for most of them, and the person's own face for the ones that
 * are about a person - somebody asking to be added, somebody who accepted. A
 * column of identical grey outlines is a column nobody scans, and "who is this
 * about" is the first question those alerts raise.
 *
 * One component because the bell and the history both draw it, and two copies is
 * how the bell ends up showing a face the page does not.
 */

import { cn } from "@polaris/ui";
import { Avatar } from "@/components/avatar";
import type { NotificationView } from "@/lib/notification-service";
import { levelStyle } from "@/components/notifications/notification-visuals";

export function NotificationFace({
    row,
    className
}: {
    row: NotificationView;
    /** Where it sits in the row. The two lists indent differently. */
    className?: string;
}) {
    if (row.about) {
        // No presence dot: this is a record of something that happened, not a
        // roster, and whether they are at their desk right now says nothing
        // about it.
        return <Avatar person={row.about} size={18} status={false} className={cn("shrink-0", className)} />;
    }
    const { Icon, color } = levelStyle(row.level, row.type);
    return <Icon className={cn("size-3.5 shrink-0", color, className)} />;
}

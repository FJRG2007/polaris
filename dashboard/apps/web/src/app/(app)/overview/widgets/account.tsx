"use client";

/**
 * The two cards about the account itself: where it is open, and what was done
 * with it.
 *
 * They are on by default and ask for no permission, because they are the only
 * cards on the grid whose subject is the reader. Somebody who lands here every
 * morning should see a device they do not recognize on the morning it appears,
 * not the first time they think to go looking for the sessions screen.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import type { Loaded } from "./infrastructure";
import { Laptop, ScrollText } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import type { OverviewActivityEntry, OverviewSessions } from "@/lib/overview/overview-service";
import { WidgetEmpty, WidgetList, WidgetRow, WidgetRowsSkeleton, WidgetUnavailable } from "../widget-card";

/**
 * An action as it was recorded, in words.
 *
 * The log stores `session.revoked`, which is the right thing to store and the
 * wrong thing to read: the card says "Session revoked" and leaves the raw name to
 * the activity screen, where somebody is filtering by it.
 */
function actionLabel(action: string): string {
    const words = action.replace(/[._-]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

export function SessionsWidget({ data }: { data: Loaded<OverviewSessions> }) {
    if (data === undefined) return <WidgetRowsSkeleton rows={3} />;
    if (data === null) return <WidgetUnavailable>Your sessions could not be read just now.</WidgetUnavailable>;
    if (data.entries.length === 0) return <WidgetEmpty>No other device is signed in.</WidgetEmpty>;

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm">
                <span className="text-xl font-semibold tabular-nums">{data.total}</span>
                <span className="text-muted-foreground">
                    {" "}
                    device{data.total === 1 ? "" : "s"} signed in
                </span>
            </p>
            <WidgetList>
                {data.entries.map((session) => (
                    <WidgetRow
                        key={session.id}
                        href="/account/sessions"
                        icon={
                            <span
                                className={cn(
                                    "grid size-7 shrink-0 place-items-center rounded-md",
                                    session.current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                                )}
                            >
                                <Laptop className="size-3.5" aria-hidden="true" />
                            </span>
                        }
                        label={session.current ? `${session.device} (this one)` : session.device}
                        detail={session.where || null}
                        trailing={
                            <span className="shrink-0 text-xs text-muted-foreground">
                                <RelativeTime iso={session.lastSeenAt} />
                            </span>
                        }
                    />
                ))}
            </WidgetList>
        </div>
    );
}

export function ActivityWidget({ data }: { data: Loaded<OverviewActivityEntry[]> }) {
    if (data === undefined) return <WidgetRowsSkeleton rows={3} />;
    if (data === null) return <WidgetUnavailable>Your activity could not be read just now.</WidgetUnavailable>;
    if (data.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <Link href="/account/activity" className="text-xs font-medium text-primary hover:underline">
                        Open the log
                    </Link>
                }
            >
                Nothing has been recorded against this account yet.
            </WidgetEmpty>
        );
    }

    return (
        <WidgetList>
            {data.map((entry) => (
                <WidgetRow
                    key={entry.id}
                    href="/account/activity"
                    icon={<ScrollText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    label={actionLabel(entry.action)}
                    detail={entry.target || null}
                    trailing={
                        <span className="shrink-0 text-xs text-muted-foreground">
                            <RelativeTime iso={entry.at} />
                        </span>
                    }
                />
            ))}
        </WidgetList>
    );
}

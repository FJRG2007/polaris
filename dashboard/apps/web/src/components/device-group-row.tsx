"use client";

/**
 * The header row of one device on a sessions table: the computer's name and
 * system, how many sessions it holds and when it was last active, with the two
 * presses that act on all of them - sign every one out, or block the device.
 *
 * The rows under it are the ordinary session rows; this one only names what
 * they share. Grouping is by the device id the clients reported
 * (`lib/device-sessions/device-groups`), so it never claims more than that.
 */

import { Badge, Button, cn } from "@polaris/ui";
import { SystemMark } from "@/components/client-marks";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Ban, ChevronDown, ChevronRight, LogOut } from "lucide-react";
import type { DeviceGroup } from "@/lib/device-sessions/device-groups";

export function DeviceGroupRow({
    group,
    open,
    onToggle,
    compact,
    busy,
    onSignOut,
    onBlock
}: {
    group: DeviceGroup;
    open: boolean;
    onToggle: () => void;
    compact: boolean;
    busy: boolean;
    /** Signs out every session on it. Left out where the reader is not the owner. */
    onSignOut?: (group: DeviceGroup) => void;
    /** Blocks it. Left out where the reader is not the owner. */
    onBlock?: (group: DeviceGroup) => void;
}) {
    const t = useTranslations("components");
    const name = group.name ?? t("sessionsTable.deviceGroup.unnamed");
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <tr className="border-t border-border bg-surface/40">
            <td className="w-full max-w-0 px-3 py-2" colSpan={compact ? 1 : 6}>
                <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-3 text-start"
                    aria-expanded={open}
                    aria-label={t(
                        open ? "sessionsTable.deviceGroup.collapse" : "sessionsTable.deviceGroup.expand",
                        { device: name }
                    )}
                    onClick={onToggle}
                >
                    <Chevron aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    {group.os ? <SystemMark os={group.os} /> : null}
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="min-w-0 truncate font-semibold" title={name}>
                            {name}
                        </span>
                        {group.os ? (
                            <span className="min-w-0 truncate text-muted-foreground">{group.os}</span>
                        ) : null}
                        <Badge variant="neutral">
                            {t("sessionsTable.deviceGroup.count", { count: group.memberIds.length })}
                        </Badge>
                        {group.here ? (
                            <Badge variant="primary">{t("sessionsTable.thisComputer")}</Badge>
                        ) : null}
                        {group.lastSeenAt ? (
                            <span className="text-xs text-muted-foreground">
                                {t.rich("sessionsTable.deviceGroup.lastActive", {
                                    time: () => <RelativeTime key="time" iso={group.lastSeenAt ?? ""} />
                                })}
                            </span>
                        ) : null}
                    </span>
                </button>
            </td>
            <td className="px-3 py-2">
                <div className={cn("flex justify-end gap-1", !onSignOut && !onBlock && "hidden")}>
                    {onSignOut ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            title={t("sessionsTable.deviceGroup.signOut")}
                            aria-label={t("sessionsTable.deviceGroup.signOutNamed", { device: name })}
                            disabled={busy}
                            onClick={() => onSignOut(group)}
                        >
                            <LogOut className="size-4" />
                        </Button>
                    ) : null}
                    {/* A block is held against a device key; a device placed
                        only by its name or its browser has none to hold. */}
                    {onBlock && group.deviceKeys.length > 0 ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            // The device in hand cannot be blocked from itself: it
                            // would end the page the press was made on and leave
                            // its owner locked out of the screen that undoes it.
                            title={t(
                                group.here
                                    ? "sessionsTable.deviceGroup.blockHere"
                                    : "sessionsTable.deviceGroup.block"
                            )}
                            aria-label={t("sessionsTable.deviceGroup.blockNamed", { device: name })}
                            disabled={busy || group.here}
                            onClick={() => onBlock(group)}
                        >
                            <Ban className="size-4" />
                        </Button>
                    ) : null}
                </div>
            </td>
        </tr>
    );
}

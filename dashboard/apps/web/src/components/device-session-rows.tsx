"use client";

/**
 * The apps signed in on a device of their own - the command line, a Stream
 * Deck, a TV - on a sessions table, as rows of the same columns and actions a
 * browser session has. Which app a row is comes from `lib/device-sessions/kinds`.
 *
 * Its own component rather than another block inside `sessions-table`: that
 * table is shared and changed often, and a row kind kept here leaves it one
 * line to render these and nothing else to merge.
 *
 * A sign-in is an API key underneath (see `lib/device-sessions/sessions`), so ending one
 * here revokes that key, and the app's next request says it was signed out.
 */

import { Badge, Button, cn } from "@polaris/ui";
import { LogOut } from "lucide-react";
import { SystemMark } from "@/components/client-marks";
import { DeviceAddress } from "@/components/device-address";
import { ActivityLink, MachineBadge, PinButton } from "@/components/sessions-table";
import type { Machine } from "@/lib/device-sessions/machines";
import { DEVICE_SESSION_KINDS } from "@/lib/device-sessions/kinds";
import type { DeviceSessionView } from "@/lib/device-sessions/sessions";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";

// The `<time>` tag is drawn by a function rather than handed an element: given
// a bare element, the translator printed the message's own markup instead.
export function DeviceSessionRows({
    sessions,
    machines,
    busyId,
    compact,
    activityHref,
    onSignOut,
    onPin
}: {
    sessions: readonly DeviceSessionView[];
    /** The computer each row runs on, read across the whole table. */
    machines?: ReadonlyMap<string, Machine>;
    busyId: string | null;
    compact: boolean;
    /** Where its history is read. Left out where the reader has no such page. */
    activityHref?: (session: { readonly id: string }) => string;
    /** Ends one. Left out where the reader may not. */
    onSignOut?: (session: DeviceSessionView) => void;
    /** The address lock for one, as for a session. Left out for an administrator. */
    onPin?: (session: DeviceSessionView, pinned: boolean | null) => void;
}) {
    const t = useTranslations("components");
    return (
        <>
            {sessions.map((session) => {
                // Where it is being used from now, or where it was approved from
                // before its first command.
                const address = session.lastUsedIp ?? session.signedInIp;
                const locked = session.pinToAddress ?? session.pinnedByRule;
                const lastUsedAt = session.lastUsedAt;
                const { icon: Mark, label } = DEVICE_SESSION_KINDS[session.kind];
                const app = t(label);
                const named = t("sessionsTable.appSignIn.named", { app, name: session.name });
                return (
                    <tr
                        key={`device-${session.id}`}
                        className={cn(
                            "border-t border-border",
                            busyId === session.id && "opacity-60"
                        )}
                    >
                        <td className="w-full max-w-0 px-3 py-2">
                            <div className="flex items-center gap-3">
                                <Mark
                                    aria-hidden
                                    className="size-4 shrink-0 text-muted-foreground"
                                />
                                <div className="min-w-0">
                                    <p className="flex flex-wrap items-center gap-1.5">
                                        <span
                                            className="min-w-0 truncate font-medium"
                                            title={session.name}
                                        >
                                            {session.name}
                                        </span>
                                        <span className="min-w-0 truncate text-muted-foreground">
                                            {session.os}
                                        </span>
                                        <Badge variant="neutral">{app}</Badge>
                                        <MachineBadge
                                            machine={machines?.get(session.id)}
                                            named={session.name}
                                        />
                                        {locked ? (
                                            <Badge title={t("sessionsTable.appSignIn.lockedHint")}>
                                                {t("sessionsTable.addressLocked")}
                                            </Badge>
                                        ) : null}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {session.signedInIp
                                            ? t.rich("sessionsTable.appSignIn.signedInFrom", {
                                                  ip: session.signedInIp,
                                                  time: () => (
                                                      <RelativeTime
                                                          key="time"
                                                          iso={session.createdAt}
                                                      />
                                                  )
                                              })
                                            : t.rich("sessionsTable.appSignIn.signedIn", {
                                                  time: () => (
                                                      <RelativeTime
                                                          key="time"
                                                          iso={session.createdAt}
                                                      />
                                                  )
                                              })}
                                    </p>
                                    <p
                                        className={cn(
                                            "truncate text-xs text-muted-foreground",
                                            !compact && "lg:hidden"
                                        )}
                                    >
                                        {lastUsedAt
                                            ? t.rich("sessionsTable.whereAndWhen", {
                                                  where:
                                                      address ??
                                                      t("sessionsTable.addressNotRecorded"),
                                                  time: () => (
                                                      <RelativeTime key="time" iso={lastUsedAt} />
                                                  )
                                              })
                                            : t("sessionsTable.appSignIn.notUsedYet")}
                                    </p>
                                </div>
                            </div>
                        </td>
                        {compact ? null : (
                            <>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs md:table-cell">
                                    <span className="flex items-center gap-2">
                                        {app}
                                        {session.version ? (
                                            <span className="tabular-nums text-muted-foreground">
                                                {session.version}
                                            </span>
                                        ) : null}
                                    </span>
                                </td>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs md:table-cell">
                                    <span className="flex items-center gap-2">
                                        <SystemMark os={session.os} />
                                        <span className="truncate" title={session.os}>
                                            {session.os}
                                        </span>
                                    </span>
                                </td>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs lg:table-cell">
                                    <DeviceAddress
                                        address={{ ip: address ?? null, publicIp: null }}
                                    />
                                </td>
                                <td className="hidden max-w-[12rem] px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                                    {t("sessionsTable.notRecorded")}
                                </td>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                    {session.lastUsedAt ? (
                                        <RelativeTime iso={session.lastUsedAt} />
                                    ) : (
                                        t("sessionsTable.appSignIn.notUsedYet")
                                    )}
                                </td>
                            </>
                        )}
                        <td className="px-3 py-2">
                            <div className="flex justify-end gap-1">
                                {activityHref ? (
                                    <ActivityLink href={activityHref(session)} device={named} />
                                ) : null}
                                {onPin ? (
                                    <PinButton
                                        label={named}
                                        pinToAddress={session.pinToAddress}
                                        pinnedByRule={session.pinnedByRule}
                                        busy={busyId !== null}
                                        onPin={(pinned) => onPin(session, pinned)}
                                    />
                                ) : null}
                                {onSignOut ? (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        title={t("sessionsTable.signOut")}
                                        aria-label={t("sessionsTable.appSignIn.signOutNamed", {
                                            app,
                                            name: session.name
                                        })}
                                        disabled={busyId !== null}
                                        onClick={() => onSignOut(session)}
                                    >
                                        <LogOut className="size-4" />
                                    </Button>
                                ) : null}
                            </div>
                        </td>
                    </tr>
                );
            })}
        </>
    );
}

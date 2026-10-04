"use client";

/**
 * The command-line sign-ins (`plr login`) on a sessions table, as rows of the
 * same columns a browser session has.
 *
 * Its own component rather than another block inside `sessions-table`: that
 * table is shared and changed often, and a row kind kept here leaves it one
 * line to render these and nothing else to merge.
 *
 * A sign-in is an API key underneath (see `lib/cli/sessions`), so ending one
 * here revokes that key, and the CLI's next command says it was signed out.
 */

import { Badge, Button, cn } from "@polaris/ui";
import { LogOut, Terminal } from "lucide-react";
import { SystemMark } from "@/components/client-marks";
import { PinButton } from "@/components/sessions-table";
import type { CliSessionView } from "@/lib/cli/sessions";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";

// The `<time>` tag is drawn by a function rather than handed an element: given
// a bare element, the translator printed the message's own markup instead.
export function CliSessionRows({
    sessions,
    busyId,
    compact,
    onSignOut,
    onPin
}: {
    sessions: readonly CliSessionView[];
    busyId: string | null;
    compact: boolean;
    /** Ends one. Left out where the reader may not. */
    onSignOut?: (session: CliSessionView) => void;
    /** The address lock for one, as for a session. Left out for an administrator. */
    onPin?: (session: CliSessionView, pinned: boolean | null) => void;
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
                return (
                    <tr
                        key={`cli-${session.id}`}
                        className={cn(
                            "border-t border-border",
                            busyId === session.id && "opacity-60"
                        )}
                    >
                        <td className="w-full max-w-0 px-3 py-2">
                            <div className="flex items-center gap-3">
                                <Terminal
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
                                        <Badge variant="neutral">
                                            {t("sessionsTable.cli.badge")}
                                        </Badge>
                                        {locked ? (
                                            <Badge title={t("sessionsTable.cli.lockedHint")}>
                                                {t("sessionsTable.addressLocked")}
                                            </Badge>
                                        ) : null}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {session.signedInIp
                                            ? t.rich("sessionsTable.cli.signedInFrom", {
                                                  ip: session.signedInIp,
                                                  time: () => (
                                                      <RelativeTime
                                                          key="time"
                                                          iso={session.createdAt}
                                                      />
                                                  )
                                              })
                                            : t.rich("sessionsTable.cli.signedIn", {
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
                                            : t("sessionsTable.cli.notUsedYet")}
                                    </p>
                                </div>
                            </div>
                        </td>
                        {compact ? null : (
                            <>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs md:table-cell">
                                    <span className="flex items-center gap-2">
                                        {t("sessionsTable.cli.badge")}
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
                                    {address ?? (
                                        <span className="text-muted-foreground">
                                            {t("sessionsTable.notRecorded")}
                                        </span>
                                    )}
                                </td>
                                <td className="hidden max-w-[12rem] px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                                    {t("sessionsTable.notRecorded")}
                                </td>
                                <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                    {session.lastUsedAt ? (
                                        <RelativeTime iso={session.lastUsedAt} />
                                    ) : (
                                        t("sessionsTable.cli.notUsedYet")
                                    )}
                                </td>
                            </>
                        )}
                        <td className="px-3 py-2">
                            <div className="flex justify-end gap-1">
                                {onPin ? (
                                    <PinButton
                                        label={t("sessionsTable.cli.named", { name: session.name })}
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
                                        aria-label={t("sessionsTable.cli.signOutNamed", {
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

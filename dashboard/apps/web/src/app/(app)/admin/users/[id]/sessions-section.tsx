"use client";

/**
 * Every device signed in as this person, and the way to end one or all of them.
 *
 * The list loads after the paint and is re-read whenever an action may have
 * ended a session: it is the one part of a record that changes while you look.
 */

import { LogOut } from "lucide-react";
import { useAccountAction } from "./use-account-action";
import { useCallback, useEffect, useState } from "react";
import type { CliSessionView } from "@/lib/cli/sessions";
import type { SessionView } from "@/lib/session-directory";
import { SessionsTable } from "@/components/sessions-table";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    revokeUserCliSessionAction,
    revokeUserSessionAction,
    revokeUserSessionsAction,
    userSessionsAction
} from "../actions";

export function SessionsSection({ user }: { user: DirectoryUser }) {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    const { busy, error, run } = useAccountAction();
    // Null until the list arrives, so the section holds its shape rather than the
    // page waiting on a query nothing above it needs.
    const [sessions, setSessions] = useState<SessionView[] | null>(null);
    const [cliSessions, setCliSessions] = useState<CliSessionView[]>([]);

    const loadSessions = useCallback(async () => {
        const result = await userSessionsAction(user.id);
        setSessions(result.sessions ?? []);
        setCliSessions(result.cliSessions ?? []);
    }, [user.id]);

    useEffect(() => {
        void loadSessions();
    }, [loadSessions]);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">
                            {t("usersDetail.account.sessions.title")}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {t("usersDetail.account.sessions.hint", { name: user.name })}
                        </p>
                    </div>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || (sessions?.length === 0 && cliSessions.length === 0)}
                        onClick={() =>
                            void run(() => revokeUserSessionsAction(user.id), loadSessions)
                        }
                    >
                        <LogOut className="size-4" />
                        {t("usersDetail.account.sessions.signOutAll")}
                    </Button>
                </div>
                {sessions ? (
                    <SessionsTable
                        compact
                        sessions={sessions}
                        busyId={busy ? "all" : null}
                        emptyLabel={t("usersDetail.account.sessions.empty")}
                        onRevoke={(session) =>
                            void run(
                                () => revokeUserSessionAction(user.id, session.id),
                                loadSessions
                            )
                        }
                        cliSessions={cliSessions}
                        onSignOutCli={(session) =>
                            void run(
                                () => revokeUserCliSessionAction(user.id, session.id),
                                loadSessions
                            )
                        }
                    />
                ) : (
                    <Skeleton className="h-24 w-full rounded-lg" />
                )}
                <p className="text-xs text-muted-foreground">
                    {t("usersDetail.account.sessions.lastSeen", {
                        seen: user.lastSeenAt ? "yes" : "no",
                        time: user.lastSeenAt ? format.dateTime(user.lastSeenAt) : "",
                        hasIp: user.lastIp ? "yes" : "no",
                        ip: user.lastIp ?? "",
                        hasCountry: user.lastCountry ? "yes" : "no",
                        country: user.lastCountry ?? ""
                    })}
                </p>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

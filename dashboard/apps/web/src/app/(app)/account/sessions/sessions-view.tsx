"use client";

/**
 * The session list. Pending sign-ins are pulled to the top and styled as a
 * decision, not a row: they are the only thing here that needs an answer, and
 * approving one is what lets somebody in.
 *
 * Device labels come from the client-supplied user-agent, so they are treated as
 * hints - the address and the timestamps are what a user should judge by.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LogOut, MonitorSmartphone, X } from "lucide-react";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { signOut } from "@/lib/auth-client";
import type { SessionView } from "@/lib/session-directory";
import { decideLoginApprovalAction, revokeOtherSessionsAction, revokeSessionAction } from "./actions";

function Origin({ session }: { session: SessionView }) {
    const where = [session.ip, session.country].filter(Boolean).join(" - ");
    return (
        <p className="text-xs text-muted-foreground">
            {where || "Unknown location"} - last active <RelativeTime iso={session.lastSeenAt} />
        </p>
    );
}

export function SessionsView({ sessions }: { sessions: SessionView[] }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const pending = sessions.filter((session) => session.approval === "pending");
    const active = sessions.filter((session) => session.approval !== "pending");
    const others = active.filter((session) => !session.current);

    async function decide(sessionId: string, approve: boolean) {
        setBusyId(sessionId);
        setError(null);
        const result = await decideLoginApprovalAction(sessionId, approve);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    async function revoke(session: SessionView) {
        const ok = await confirm({
            title: "Sign this device out?",
            description: `${session.device} will need to sign in again.`,
            confirmLabel: "Sign out",
            danger: true
        });
        if (!ok) return;
        setBusyId(session.id);
        setError(null);
        const result = await revokeSessionAction(session.id);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    /** Ending your own session goes through the auth client, so the cookie is
     *  dropped here too - deleting the row alone would leave a stale one. */
    async function signOutHere() {
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    async function revokeOthers() {
        const ok = await confirm({
            title: "Sign out everywhere else?",
            description: `${others.length} other session${others.length === 1 ? "" : "s"} will end immediately.`,
            confirmLabel: "Sign them out",
            danger: true
        });
        if (!ok) return;
        setBusyId("all");
        await revokeOtherSessionsAction();
        setBusyId(null);
        router.refresh();
    }

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {pending.length > 0 ? (
                <Card className="border-warning/40">
                    <CardBody className="flex flex-col gap-3">
                        <div>
                            <h2 className="text-sm font-medium">Waiting for your approval</h2>
                            <p className="text-xs text-muted-foreground">
                                Allow this sign-in only if you recognize it.
                            </p>
                        </div>
                        {pending.map((session) => (
                            <div
                                key={session.id}
                                className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="min-w-0">
                                    <p className="text-sm">{session.device}</p>
                                    <Origin session={session} />
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busyId === session.id}
                                        onClick={() => void decide(session.id, false)}
                                    >
                                        <X className="size-4" />
                                        Deny
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={busyId === session.id}
                                        onClick={() => void decide(session.id, true)}
                                    >
                                        <Check className="size-4" />
                                        Approve
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </CardBody>
                </Card>
            ) : null}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <h2 className="text-sm font-medium">Active sessions</h2>
                        {others.length > 0 ? (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busyId === "all"}
                                onClick={() => void revokeOthers()}
                            >
                                <LogOut className="size-4" />
                                Sign out everywhere else
                            </Button>
                        ) : null}
                    </div>

                    {active.map((session) => (
                        <div
                            key={session.id}
                            className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                        >
                            <div className="flex min-w-0 items-center gap-3">
                                <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0">
                                    <p className="flex items-center gap-2 text-sm">
                                        <span className="truncate">{session.device}</span>
                                        {session.current ? <Badge variant="primary">This device</Badge> : null}
                                        {session.locked ? <Badge>Locked</Badge> : null}
                                    </p>
                                    <Origin session={session} />
                                </div>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === session.id}
                                onClick={() => void (session.current ? signOutHere() : revoke(session))}
                            >
                                Sign out
                            </Button>
                        </div>
                    ))}
                </CardBody>
            </Card>

            {confirmElement}
        </div>
    );
}

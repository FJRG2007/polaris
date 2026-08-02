"use client";

/**
 * The session list. Pending sign-ins are pulled to the top and styled as a
 * decision, not a row: they are the only thing here that needs an answer, and
 * approving one is what lets somebody in.
 *
 * Device labels come from the client-supplied user-agent, so they are treated as
 * hints - the address and the timestamps are what a user should judge by. When
 * those are not enough to place a session, Activity opens what was actually done
 * from it before deciding whether to sign it out.
 */

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Check, LogOut, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { SessionView } from "@/lib/session-directory";
import { SessionActivityDialog } from "./session-activity-dialog";
import { SessionsTable, sessionOrigin } from "@/components/sessions-table";
import { decideLoginApprovalAction, revokeOtherSessionsAction, revokeSessionAction } from "./actions";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

function Origin({ session }: { session: SessionView }) {
    return (
        <p className="text-xs text-muted-foreground">
            {sessionOrigin(session)} - last active <RelativeTime iso={session.lastSeenAt} />
        </p>
    );
}

export function SessionsView({ sessions }: { sessions: SessionView[] }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activityFor, setActivityFor] = useState<SessionView | null>(null);
    const [approving, setApproving] = useState<SessionView | null>(null);

    const pending = sessions.filter((session) => session.approval === "pending");
    const active = sessions.filter((session) => session.approval !== "pending");
    const others = active.filter((session) => !session.current);

    /** Refusing is immediate; allowing goes through the PIN prompt first. */
    async function deny(sessionId: string) {
        setBusyId(sessionId);
        setError(null);
        const result = await decideLoginApprovalAction(sessionId, false);
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
                                        onClick={() => void deny(session.id)}
                                    >
                                        <X className="size-4" />
                                        Deny
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={busyId === session.id}
                                        onClick={() => setApproving(session)}
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

                    <SessionsTable
                        sessions={active}
                        busyId={busyId}
                        emptyLabel="Nothing is signed in."
                        onActivity={setActivityFor}
                        onRevoke={(session) => void (session.current ? signOutHere() : revoke(session))}
                    />
                </CardBody>
            </Card>

            <SessionActivityDialog
                session={activityFor}
                onOpenChange={(open) => {
                    if (!open) setActivityFor(null);
                }}
            />

            <ApproveSignInDialog
                session={approving}
                onOpenChange={(open) => {
                    if (!open) setApproving(null);
                }}
                onApproved={() => {
                    setApproving(null);
                    router.refresh();
                }}
            />

            {confirmElement}
        </div>
    );
}

/**
 * The PIN prompt in front of an approval. An open dashboard is not proof that
 * the person at it is the account owner, so letting a new device in asks for the
 * quick-unlock PIN - the same secret that reopens a locked session.
 */
function ApproveSignInDialog({
    session,
    onOpenChange,
    onApproved
}: {
    session: SessionView | null;
    onOpenChange: (open: boolean) => void;
    onApproved: () => void;
}) {
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!session) return;
        setBusy(true);
        setError(null);
        const result = await decideLoginApprovalAction(session.id, true, pin);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setPin("");
        onApproved();
    }

    return (
        <Dialog
            open={session !== null}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setPin("");
                    setError(null);
                }
            }}
        >
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Allow this sign-in?</DialogTitle>
                    <DialogDescription>
                        {session?.device} gets in as you. Enter your unlock PIN to confirm.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Unlock PIN
                        <Input
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            autoComplete="off"
                            value={pin}
                            onChange={(event) => setPin(event.target.value)}
                            required
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || pin.length < 4}>
                            {busy ? "Checking..." : "Approve"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

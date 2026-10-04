"use client";

/**
 * The session list. Pending sign-ins are pulled to the top and styled as a
 * decision, not a row: they are the only thing here that needs an answer, and
 * approving one is what lets somebody in.
 *
 * Device labels come from the client-supplied user-agent, so they are treated as
 * hints - the address and the timestamps are what a user should judge by. When
 * those are not enough to place a session, Activity leads to the log narrowed to
 * that session, which is what was actually done from it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { useState, type FormEvent } from "react";
import { codeDigits } from "@/components/code-input";
import { useConfirm } from "@/components/confirm-dialog";
import { Check, LogOut, ScanLine, X } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { VaultClientRow } from "@/lib/vault/devices";
import type { CliSessionView } from "@/lib/cli/sessions";
import type { ExtensionSessionView } from "@/lib/extension/sessions";
import { TrustedDevicesCard } from "./trusted-devices-card";
import { signInParts, signInText } from "@/lib/sign-in-words";
import { SessionsTable, sessionOrigin } from "@/components/sessions-table";
import type { SessionView, TrustedDeviceRow } from "@/lib/session-directory";
import {
    decideLoginApprovalAction,
    disconnectExtensionAction,
    noteSignOutAction,
    revokeOtherSessionsAction,
    pinCliSessionAction,
    pinExtensionAction,
    pinSessionAction,
    revokeSessionAction,
    signOutCliSessionAction
} from "./actions";
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
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("components");
    return (
        <>
            <p className="text-xs text-muted-foreground">
                {t.rich("sessions.origin", {
                    origin: sessionOrigin(session, tc("sessionsTable.unknownLocation")),
                    time: <RelativeTime key="time" iso={session.lastSeenAt} />
                })}
            </p>
            {/* Most of what this decision rests on, next to where it came from:
                a sign-in that already answered a code is a different thing to
                allow than one that only had the password. */}
            {signInParts(tc, session.signIn).length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t("sessions.signedInWith", { summary: signInText(tc, session.signIn) })}
                </p>
            ) : null}
        </>
    );
}

export function SessionsView({
    sessions,
    trusted,
    extensions,
    clients,
    cliSessions
}: {
    sessions: SessionView[];
    /** Browsers allowed to skip the second-factor challenge. Empty on an account
     *  that has never armed one, which is when the card stays away. */
    trusted: TrustedDeviceRow[];
    /** The browser extensions connected to this account, ended from here like
     *  any other device. */
    extensions: ExtensionSessionView[];
    /** Apps signed in to this account - the extension, and anything else that was
     *  let in. They belong in the table above rather than in a card of their own:
     *  the extension is this account signed in from the same machine as the row
     *  beside it, and listing it separately said it was something external. */
    clients: VaultClientRow[];
    /** The command-line sign-ins, listed and ended like any other session. */
    cliSessions: CliSessionView[];
}) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const [confirm, confirmElement] = useConfirm();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [approving, setApproving] = useState<SessionView | null>(null);

    const pending = sessions.filter((session) => session.approval === "pending");
    const active = sessions.filter((session) => session.approval !== "pending");
    const others = active.filter((session) => !session.current);
    // What "everywhere else" reaches: the other browsers and every extension.
    // And every command-line sign-in: none of them is the browser this is.
    const elsewhere = others.length + extensions.length + cliSessions.length;

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
            title: t("sessions.revoke.title"),
            description: t("sessions.revoke.description", { device: session.device }),
            confirmLabel: t("sessions.revoke.confirm"),
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

    /** Sign a command-line sign-in out. Its key is revoked, so the CLI's next
     *  command says it was signed out and to run plr login. */
    async function signOutCli(session: CliSessionView) {
        const ok = await confirm({
            title: t("sessions.cli.title"),
            description: t("sessions.cli.description", { name: session.name }),
            confirmLabel: t("sessions.cli.confirm"),
            danger: true
        });
        if (!ok) return;
        setBusyId(session.id);
        setError(null);
        const result = await signOutCliSessionAction(session.id);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    async function pinCli(session: CliSessionView, pinned: boolean | null) {
        setBusyId(session.id);
        setError(null);
        const result = await pinCliSessionAction(session.id, pinned);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    /**
     * End one extension's connection.
     *
     * What it takes with it is said before it is done: a connection that was let
     * into a vault took the key with it, and ending the connection is what
     * closes that as well.
     */
    async function disconnect(extension: ExtensionSessionView) {
        const ok = await confirm({
            title: t("sessions.disconnect.title"),
            description:
                extension.vaultClients > 0
                    ? t("sessions.disconnect.withVault", { browser: extension.browser, os: extension.os })
                    : t("sessions.disconnect.description", { browser: extension.browser, os: extension.os }),
            confirmLabel: t("sessions.disconnect.confirm"),
            danger: true
        });
        if (!ok) return;
        setBusyId(extension.id);
        setError(null);
        const result = await disconnectExtensionAction(extension.id);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    /** Tie one session to its address, untie it, or hand it back to the account
     *  rule. No confirmation: it takes nothing away that a press cannot put back,
     *  and the button says what it is about to do. */
    async function pin(session: SessionView, pinned: boolean | null) {
        setBusyId(session.id);
        setError(null);
        const result = await pinSessionAction(session.id, pinned);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    /** The same three answers for an extension's connection. */
    async function pinExtension(extension: ExtensionSessionView, pinned: boolean | null) {
        setBusyId(extension.id);
        setError(null);
        const result = await pinExtensionAction(extension.id, pinned);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    /** Ending your own session goes through the auth client, so the cookie is
     *  dropped here too - deleting the row alone would leave a stale one. */
    async function signOutHere() {
        await noteSignOutAction().catch(() => undefined);
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    async function revokeOthers() {
        const ok = await confirm({
            title: t("sessions.others.title"),
            description:
                extensions.length > 0
                    ? t("sessions.others.withExtensions", { sessions: others.length, extensions: extensions.length })
                    : t("sessions.others.description", { sessions: others.length }),
            confirmLabel: t("sessions.others.confirm"),
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
                <Card className="border-warning-edge">
                    <CardBody className="flex flex-col gap-3">
                        <div>
                            <h2 className="text-sm font-medium">{t("sessions.pending.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("sessions.pending.hint")}</p>
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
                                        {t("sessions.pending.deny")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={busyId === session.id}
                                        onClick={() => setApproving(session)}
                                    >
                                        <Check className="size-4" />
                                        {t("sessions.pending.approve")}
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </CardBody>
                </Card>
            ) : null}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-medium">{t("sessions.active.title")}</h2>
                        <div className="flex flex-wrap gap-2">
                            {/* The other way a sign-in gets let in: the code on the
                                sign-in screen, answered here instead of waiting for
                                somebody to find this page. */}
                            <Link href="/account/scan">
                                <Button variant="outline" size="sm">
                                    <ScanLine className="size-4" />
                                    {t("sessions.active.scan")}
                                </Button>
                            </Link>
                            {elsewhere > 0 ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busyId === "all"}
                                    onClick={() => void revokeOthers()}
                                >
                                    <LogOut className="size-4" />
                                    {t("sessions.active.signOutOthers")}
                                </Button>
                            ) : null}
                        </div>
                    </div>

                    <SessionsTable
                        extensions={extensions}
                        onDisconnect={disconnect}
                        onPinExtension={(extension, pinned) => void pinExtension(extension, pinned)}
                        sessions={active}
                        clients={clients}
                        busyId={busyId}
                        emptyLabel={t("sessions.active.empty")}
                        activityHref={(session) => `/account/activity?session=${session.id}`}
                        onRevoke={(session) =>
                            void (session.current ? signOutHere() : revoke(session))
                        }
                        onPin={(session, pinned) => void pin(session, pinned)}
                        cliSessions={cliSessions}
                        onSignOutCli={(session) => void signOutCli(session)}
                        onPinCli={(session, pinned) => void pinCli(session, pinned)}
                    />

                    {/* The table says nothing about apps until one is connected,
                        and the way to the screen that manages them is on a row. So
                        with no rows this page answers neither "is anything
                        connected" nor "where do I go about it", which is the
                        question that brings people here. */}
                    {extensions.length === 0 && clients.length === 0 && cliSessions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t.rich("sessions.active.nothingElse", {
                                link: (chunks) => (
                                    <Link
                                        key="link"
                                        href="/account/extension"
                                        className="underline-offset-2 hover:text-foreground hover:underline"
                                    >
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </p>
                    ) : null}
                </CardBody>
            </Card>

            {trusted.length > 0 ? <TrustedDevicesCard devices={trusted} /> : null}

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
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
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
                    <DialogTitle>{t("sessions.approve.title")}</DialogTitle>
                    <DialogDescription>
                        {t("sessions.approve.description", { device: session?.device ?? "" })}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("sessions.approve.pin")}
                        <Input
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            autoComplete="off"
                            value={pin}
                            onChange={(event) => setPin(codeDigits(event.target.value))}
                            required
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy || pin.length < 4}>
                            {busy ? t("sessions.approve.checking") : t("sessions.pending.approve")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

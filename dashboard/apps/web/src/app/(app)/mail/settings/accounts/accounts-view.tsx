"use client";

/**
 * Connecting a mailbox.
 *
 * The flow is one field long for nearly everybody: type the address, and Polaris
 * works out where its mail lives. What happens next depends only on what it
 * found.
 *
 * - **A service that can be authorized** (Gmail, Outlook): a Connect button, and
 *   no password is ever typed. If the account is already linked here for
 *   something else, it is offered directly.
 * - **A service that needs a password**: one password field, with the sentence
 *   that service's own support page would have said - "Google refuses your
 *   ordinary password here", "Yahoo needs an app password" - because that is the
 *   single most common reason a correct password is refused.
 * - **Anything else**: the servers Polaris found, filled in and editable. The
 *   fields are shown rather than hidden behind "advanced": somebody who got here
 *   is somebody whose domain answered nothing, and hiding the fields from them
 *   would be hiding the only thing left to try.
 *
 * Nothing is stored until both servers have accepted the credential, so a
 * mistyped password fails on this form rather than as a mailbox that silently
 * never syncs.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { useEffect, useRef, useState, useTransition } from "react";
import { setWorkspaceScopeAction } from "@/app/(app)/scope-actions";
import { Button, ConfirmDeleteDialog, Switch, cn, useToast } from "@polaris/ui";
import { ConnectMailboxDialog, type LinkedAccount } from "@/app/(app)/mail/connect-dialog";
import { AlertTriangle, CheckCircle2, Mail, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    editAccountAction,
    removeAccountAction,
    syncAccountAction
} from "@/app/(app)/mail/actions";

export function AccountsView({
    accounts,
    links,
    googleReady,
    publicAddress,
    canSetDomain,
    microsoftReady,
    outcome,
    outcomeProvider,
    connectNow = false,
    editNow = "",
    moveShelf = null
}: {
    accounts: MailAccountView[];
    links: LinkedAccount[];
    googleReady: boolean;
    publicAddress: boolean;
    canSetDomain: boolean;
    microsoftReady: boolean;
    outcome: string;
    outcomeProvider: string;
    /** Open the connect dialog straight away. */
    connectNow?: boolean;
    /**
     * Open one mailbox's edit form straight away - where the notice that a
     * mailbox stopped accepting its password sends somebody. A refused mailbox
     * opens on its password box, because that is the field they came to fill.
     */
    editNow?: string;
    /**
     * The shelf the mailbox `editNow` names is on, when the header is on a
     * different one. The list is already that shelf's; the header is moved to
     * match, so the two do not disagree about which mailboxes these are.
     */
    moveShelf?: string | null;
}) {
    const router = useRouter();
    const movedTo = useRef<string | null>(null);
    useEffect(() => {
        if (!moveShelf) {
            movedTo.current = null;
            return;
        }
        if (movedTo.current === moveShelf) return;
        movedTo.current = moveShelf;
        void setWorkspaceScopeAction(moveShelf).then(
            () => router.refresh(),
            () => undefined
        );
    }, [moveShelf, router]);
    const [adding, setAdding] = useState(connectNow);
    const [editing, setEditing] = useState<{ id: string; focusPassword: boolean } | null>(() => {
        const asked = accounts.find((account) => account.id === editNow);
        return asked ? { id: asked.id, focusPassword: asked.state === "auth" } : null;
    });
    // The same, for a notice pressed while this screen is already open: the
    // address changes and the view stays mounted. Once per `?edit=`, so the
    // refresh that follows a save does not open the form it just closed.
    const openedFor = useRef(editNow);
    useEffect(() => {
        if (!editNow) {
            openedFor.current = "";
            return;
        }
        if (openedFor.current === editNow) return;
        const asked = accounts.find((account) => account.id === editNow);
        if (!asked) return;
        openedFor.current = editNow;
        setEditing({ id: asked.id, focusPassword: asked.state === "auth" });
    }, [editNow, accounts]);
    /**
     * What a row says while its edit is with the servers: the new name at once,
     * and "checking" where a credential is being tried. Dropped when the
     * server's own list arrives, or taken back by the dialog on a refusal.
     */
    const [pending, setPending] = useState<Record<string, Partial<MailAccountView>>>({});
    useEffect(() => setPending({}), [accounts]);

    const shown = accounts.map((account) => ({ ...account, ...pending[account.id] }));
    const editedAccount = editing
        ? accounts.find((account) => account.id === editing.id)
        : undefined;

    function closeEditor(): void {
        setEditing(null);
        // Arrived with `?edit=`: leaving it on the address would open the form
        // again on the next refresh, which is every save.
        if (editNow) router.replace("/mail/settings/accounts", { scroll: false });
    }

    return (
        <div className="space-y-4">
            {outcome === "linked" ? (
                <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                    {outcomeProvider === "microsoft" ? "Microsoft" : "Google"} account authorized.
                    Add the mailbox below and it will be offered without a password.
                </p>
            ) : null}
            {outcome === "not_public" ? (
                <p className="rounded-md border border-danger-edge bg-card px-3 py-2 text-[13px] text-danger">
                    {outcomeProvider === "microsoft" ? "Microsoft" : "Google"} had nowhere to send
                    you back to. Polaris is only reachable on this network, and an address like that
                    is one they refuse.{" "}
                    {canSetDomain ? (
                        <Link href="/admin/domains" className="underline">
                            Give Polaris a public address
                        </Link>
                    ) : (
                        "Ask an administrator to give Polaris a public address."
                    )}
                </p>
            ) : outcome && outcome !== "linked" ? (
                <p className="rounded-md border border-danger-edge bg-card px-3 py-2 text-[13px] text-danger">
                    That authorization did not finish. Nothing was changed.
                </p>
            ) : null}

            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-[15px] font-semibold tracking-tight">Your mailboxes</h2>
                    <p className="text-[13px] text-muted-foreground">
                        Connect as many as you like. They share one inbox and each keeps its own
                        colour.
                    </p>
                </div>
                <Button onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    Add a mailbox
                </Button>
            </div>

            {accounts.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
                    <Mail className="mx-auto size-5 shrink-0 text-foreground-subtle" aria-hidden />
                    <p className="mt-2 text-[13px] font-medium">No mailboxes yet</p>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        Connect one and your mail is read here instead of in somebody else&apos;s
                        browser tab.
                    </p>
                </div>
            ) : (
                <ul className="space-y-2">
                    {shown.map((account) => (
                        <AccountRow
                            key={account.id}
                            account={account}
                            onEdit={(focusPassword) =>
                                setEditing({ id: account.id, focusPassword })
                            }
                        />
                    ))}
                </ul>
            )}

            {editedAccount ? (
                <ConnectMailboxDialog
                    // One form per mailbox: opening another starts from its own
                    // values rather than the last one's.
                    key={editedAccount.id}
                    editing={editedAccount}
                    focusPassword={editing?.focusPassword ?? false}
                    title="Edit mailbox"
                    links={links}
                    googleReady={googleReady}
                    microsoftReady={microsoftReady}
                    publicAddress={publicAddress}
                    canSetDomain={canSetDomain}
                    onPending={(next) =>
                        setPending((held) => {
                            const rest = { ...held };
                            delete rest[editedAccount.id];
                            return next ? { ...rest, [editedAccount.id]: next } : rest;
                        })
                    }
                    onClose={closeEditor}
                />
            ) : null}

            {adding ? (
                <ConnectMailboxDialog
                    links={links}
                    googleReady={googleReady}
                    microsoftReady={microsoftReady}
                    publicAddress={publicAddress}
                    canSetDomain={canSetDomain}
                    // What this screen is a list of. The dialog can answer
                    // "you already have that one" while it is being typed
                    // rather than after a lookup and a password.
                    taken={accounts.map((account) => account.address)}
                    onClose={() => setAdding(false)}
                />
            ) : null}
        </div>
    );
}

function AccountRow({
    account,
    onEdit
}: {
    account: MailAccountView;
    /** Open the edit form, on the password box when that is what is wrong. */
    onEdit: (focusPassword: boolean) => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const [busy, startBusy] = useTransition();
    const [removing, setRemoving] = useState(false);
    const [unified, setUnified] = useState(account.unified);
    const [notify, setNotify] = useState(account.notify);

    const refused = account.state === "auth";
    const broken = refused || account.state === "unreachable";

    return (
        <li className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] font-medium">
                        {account.color ? (
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: account.color }}
                                aria-hidden
                            />
                        ) : null}
                        <span className="min-w-0 truncate" title={account.label || account.address}>
                            {account.label || account.address}
                        </span>
                        {account.serviceName ? (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                {account.serviceName}
                            </span>
                        ) : null}
                        {account.auth === "oauth" ? (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                Authorized
                            </span>
                        ) : null}
                    </p>
                    <p
                        className="truncate text-[12px] text-muted-foreground"
                        title={account.address}
                    >
                        {account.address}
                    </p>
                    <p
                        className={cn(
                            "mt-0.5 flex items-center gap-1.5 text-[12px]",
                            broken ? "text-danger" : "text-foreground-subtle"
                        )}
                    >
                        {broken ? (
                            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                        ) : account.state === "checking" ? (
                            <RefreshCw className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        ) : (
                            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                        )}
                        {stateSentence(account)}
                    </p>
                </div>

                {refused ? (
                    <Button size="sm" variant="outline" onClick={() => onEdit(true)}>
                        {account.auth === "oauth" ? "Reconnect" : "Update password"}
                    </Button>
                ) : null}

                <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
                    <Switch
                        checked={unified}
                        onChange={(next) => {
                            setUnified(next);
                            startBusy(async () => {
                                // Only this switch. The edit is a patch, so the
                                // rest of the mailbox's settings are left alone.
                                const answer = await editAccountAction(account.id, {
                                    unified: next
                                });
                                const said = refusalOf(answer);
                                if (said) {
                                    setUnified(!next);
                                    toast.show({ title: said });
                                    return;
                                }
                                router.refresh();
                            });
                        }}
                        aria-label="Include this mailbox in the shared inbox"
                    />
                    In the shared inbox
                </label>

                <label
                    className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground"
                    title="A notice from your system when new mail arrives here while Polaris is in another tab or window"
                >
                    <Switch
                        checked={notify}
                        onChange={(next) => {
                            setNotify(next);
                            startBusy(async () => {
                                const answer = await editAccountAction(account.id, {
                                    notify: next
                                });
                                const said = refusalOf(answer);
                                if (said) {
                                    setNotify(!next);
                                    toast.show({ title: said });
                                    return;
                                }
                                router.refresh();
                            });
                        }}
                        aria-label="Tell me when new mail arrives in this mailbox"
                    />
                    Notify me
                </label>

                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Check this mailbox now"
                    title="Check this mailbox now"
                    disabled={busy}
                    onClick={() =>
                        startBusy(async () => {
                            const answer = await syncAccountAction(account.id);
                            const said = refusalOf(answer);
                            if (said) toast.show({ title: said });
                            router.refresh();
                        })
                    }
                >
                    <RefreshCw
                        className={cn("size-4 shrink-0", busy && "animate-spin")}
                        aria-hidden
                    />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit this mailbox"
                    title="Edit this mailbox"
                    onClick={() => onEdit(false)}
                >
                    <Pencil className="size-4 shrink-0" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove this mailbox"
                    title="Remove this mailbox"
                    onClick={() => setRemoving(true)}
                >
                    <Trash2 className="size-4 shrink-0" aria-hidden />
                </Button>
            </div>

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => setRemoving(next)}
                    name={account.address}
                    kind="mailbox"
                    // One row of several and nothing inside it is lost, so a
                    // plain confirmation rather than typing the address out.
                    requireTyping={false}
                    title={`Remove ${account.address}?`}
                    // Said plainly, because "remove mailbox" reads as "delete my
                    // mail" to anybody who has not thought about where it lives.
                    description="Polaris stops checking this mailbox and forgets the copy it keeps. Nothing on the mail server is touched, and your mail stays exactly where it is."
                    confirmLabel="Remove it"
                    onConfirm={async () => {
                        const answer = await removeAccountAction(account.id);
                        const said = refusalOf(answer);
                        if (said) {
                            toast.show({ title: said });
                            return;
                        }
                        toast.show({ title: `${account.address} is no longer connected.` });
                        router.refresh();
                    }}
                />
            ) : null}
        </li>
    );
}

function stateSentence(account: MailAccountView): string {
    if (account.state === "checking") return "Checking the new details with its servers...";
    if (account.state === "auth") {
        // Said as what happened and what Polaris did about it. The detail is
        // the refusal's own sentence, which is Polaris' words, never the
        // server's.
        return account.auth === "oauth"
            ? `${account.stateDetail || "Its authorization was refused."} Checking is paused until it is reconnected.`
            : `${account.stateDetail || "The server stopped accepting its password."} Checking is paused until the password is updated.`;
    }
    if (account.state === "unreachable") return "Polaris cannot reach this mail server.";
    if (account.state === "never") return "Waiting for its first check.";
    return account.lastSyncAt ? "Checked recently." : "Connected.";
}

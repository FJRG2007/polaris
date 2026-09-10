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
import { useState, useTransition } from "react";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, ConfirmDeleteDialog, Switch, cn, useToast } from "@polaris/ui";
import { AlertTriangle, CheckCircle2, Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ConnectMailboxDialog, type LinkedAccount } from "@/app/(app)/mail/connect-dialog";
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
    outcomeProvider
}: {
    accounts: MailAccountView[];
    links: LinkedAccount[];
    googleReady: boolean;
    publicAddress: boolean;
    canSetDomain: boolean;
    microsoftReady: boolean;
    outcome: string;
    outcomeProvider: string;
}) {
    const [adding, setAdding] = useState(false);

    return (
        <div className="space-y-4">
            {outcome === "linked" ? (
                <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                    {outcomeProvider === "microsoft" ? "Microsoft" : "Google"} account authorized.
                    Add the mailbox below and it will be offered without a password.
                </p>
            ) : null}
            {outcome === "not_public" ? (
                <p className="rounded-md border border-danger/40 bg-card px-3 py-2 text-[13px] text-danger">
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
                <p className="rounded-md border border-danger/40 bg-card px-3 py-2 text-[13px] text-danger">
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
                    {accounts.map((account) => (
                        <AccountRow key={account.id} account={account} />
                    ))}
                </ul>
            )}

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

function AccountRow({ account }: { account: MailAccountView }) {
    const router = useRouter();
    const toast = useToast();
    const [busy, startBusy] = useTransition();
    const [removing, setRemoving] = useState(false);
    const [unified, setUnified] = useState(account.unified);
    const [notify, setNotify] = useState(account.notify);

    const broken = account.state === "auth" || account.state === "unreachable";

    return (
        <li className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] font-medium">
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
                        ) : (
                            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                        )}
                        {stateSentence(account)}
                    </p>
                </div>

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
                                const answer = await editAccountAction(account.id, { notify: next });
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
    if (account.state === "auth") {
        return account.stateDetail || "This mailbox needs connecting again.";
    }
    if (account.state === "unreachable") return "Polaris cannot reach this mail server.";
    if (account.state === "never") return "Waiting for its first check.";
    return account.lastSyncAt ? "Checked recently." : "Connected.";
}

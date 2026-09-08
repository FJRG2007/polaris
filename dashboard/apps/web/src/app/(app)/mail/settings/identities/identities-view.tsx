"use client";

/**
 * The other addresses a mailbox may send from.
 *
 * Nothing here claims to have checked that the mail server will accept one. Only
 * the server can say that, and it says it by refusing the message - so the
 * screen says as much rather than showing a tick it has not earned.
 */

import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailIdentityView } from "@/lib/mailbox/labels";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, Input, Switch, Textarea, cn, useToast } from "@polaris/ui";
import { deleteIdentityAction, saveIdentityAction } from "@/app/(app)/mail/actions";
import { addressState } from "@/app/(app)/mail/address-state";

export function IdentitiesView({
    accounts,
    identities
}: {
    accounts: MailAccountView[];
    identities: Record<string, MailIdentityView[]>;
}) {
    const router = useRouter();
    const toast = useToast();
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const mine = identities[account.id] ?? [];
    const [adding, setAdding] = useState(false);

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

            <div className="mb-3 flex items-center justify-between">
                <div>
                    <h2 className="text-[13px] font-medium">Addresses {account.address} can send as</h2>
                    <p className="text-[12px] text-muted-foreground">
                        Whether the mail server accepts one is its decision. If it refuses, the message comes back
                        with its reason.
                    </p>
                </div>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    Add one
                </Button>
            </div>

            {mine.length === 0 && !adding ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    Everything is sent as {account.address}.
                </p>
            ) : null}

            <ul className="space-y-2">
                {mine.map((identity) => (
                    <li key={identity.id} className="rounded-md border border-border bg-card px-3 py-2">
                        <div className="flex items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] font-medium" title={identity.address}>{identity.address}</p>
                                <p className="truncate text-[12px] text-muted-foreground">
                                    {identity.displayName || "No name set"}
                                    {identity.isDefault ? " - used by default" : ""}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove ${identity.address}`}
                                title={`Remove ${identity.address}`}
                                onClick={() =>
                                    void (async () => {
                                        const answer = await deleteIdentityAction(account.id, identity.id);
                                        const said = refusalOf(answer);
                                        if (said) {
                                            toast.show({ title: said });
                                            return;
                                        }
                                        router.refresh();
                                    })()
                                }
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>

            {adding ? (
                <IdentityForm
                    accountId={account.id}
                    // Every address this mailbox can already send as, its own
                    // included: adding the mailbox's own address as a send-as is
                    // the same duplicate, and it is the one somebody types first.
                    taken={[account.address, ...mine.map((identity) => identity.address)]}
                    onDone={() => {
                        setAdding(false);
                        router.refresh();
                    }}
                    onCancel={() => setAdding(false)}
                />
            ) : null}
        </div>
    );
}

function IdentityForm({
    accountId,
    taken,
    onDone,
    onCancel
}: {
    accountId: string;
    /** The addresses this mailbox already sends as. The server refuses a repeat
     *  in the same words - see `saveIdentity` - and this says so while it is
     *  being typed rather than after Add it. */
    taken: readonly string[];
    onDone: () => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const [address, setAddress] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [replyTo, setReplyTo] = useState("");
    const [signature, setSignature] = useState("");
    const [isDefault, setIsDefault] = useState(false);
    const [problem, setProblem] = useState("");
    const [saving, startSaving] = useTransition();

    // Read as it is typed, against the list this screen is already showing.
    const state = addressState(address, taken);
    const wrong =
        state === "invalid"
            ? "That is not an email address yet."
            : state === "taken"
              ? "This mailbox can already send as that address."
              : "";

    return (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    Address <span aria-hidden>*</span>
                </span>
                <Input
                    value={address}
                    autoFocus
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    aria-invalid={wrong ? true : undefined}
                    aria-describedby="identity-address"
                    onChange={(event) => setAddress(event.target.value)}
                />
                <span
                    id="identity-address"
                    className={cn("mt-1 block text-[12px]", wrong ? "text-danger" : "text-foreground-subtle")}
                >
                    {wrong || "Mail sent from this address still goes out through this mailbox."}
                </span>
            </label>
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">Name people will see</span>
                <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    Replies go to, if not this address
                </span>
                <Input value={replyTo} onChange={(event) => setReplyTo(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    Signature for this address
                </span>
                <Textarea rows={3} value={signature} onChange={(event) => setSignature(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-[13px]">
                <Switch checked={isDefault} onChange={setIsDefault} aria-label="Send from this address by default" />
                Send from this one by default
            </label>

            {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

            <div className="flex gap-2">
                <Button
                    disabled={saving || state !== "ok"}
                    onClick={() =>
                        startSaving(async () => {
                            setProblem("");
                            const answer = await saveIdentityAction(accountId, null, {
                                address,
                                displayName,
                                replyTo,
                                signature,
                                isDefault
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                setProblem(said);
                                return;
                            }
                            toast.show({ title: `${address} can be sent from now.` });
                            onDone();
                        })
                    }
                >
                    Add it
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

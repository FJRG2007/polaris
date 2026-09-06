"use client";

/**
 * A signature, and where it sits on a reply.
 *
 * Save stays disabled until something actually differs from what was loaded, so
 * opening the screen and closing it writes nothing - and a value edited and put
 * back leaves it disabled too, because the mailbox is then exactly as it was.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { editAccountAction } from "@/app/(app)/mail/actions";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, Switch, Textarea, useToast } from "@polaris/ui";

export function SignatureView({ accounts }: { accounts: MailAccountView[] }) {
    const router = useRouter();
    const toast = useToast();
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;

    const [signature, setSignature] = useState(account.signature);
    const [above, setAbove] = useState(account.signatureAboveQuote);
    const [saving, startSaving] = useTransition();

    function pick(next: string): void {
        const chosen = accounts.find((one) => one.id === next);
        if (!chosen) return;
        setAccountId(next);
        setSignature(chosen.signature);
        setAbove(chosen.signatureAboveQuote);
    }

    const dirty = signature !== account.signature || above !== account.signatureAboveQuote;

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={pick} />

            <div className="space-y-3">
                <label className="block">
                    <span className="mb-1 block text-[12px] text-muted-foreground">
                        Signed on every message from {account.address}
                    </span>
                    <Textarea
                        value={signature}
                        rows={6}
                        onChange={(event) => setSignature(event.target.value)}
                        placeholder="Your name, and whatever else belongs at the bottom of your mail."
                    />
                </label>

                <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Switch checked={above} onChange={setAbove} aria-label="Put the signature above the quoted message" />
                    Above the quoted message
                </label>
                <p className="text-[12px] text-foreground-subtle">
                    Above is what most people expect on a reply. Below is what a mailing list expects.
                </p>

                <Button
                    disabled={!dirty || saving}
                    onClick={() =>
                        startSaving(async () => {
                            const answer = await editAccountAction(account.id, {
                                displayName: account.displayName,
                                label: account.label,
                                color: account.color,
                                notify: account.notify,
                                pollSeconds: account.pollSeconds,
                                unified: account.unified,
                                appendToSent: account.appendToSent,
                                signature,
                                signatureAboveQuote: above
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({ title: "Signature saved." });
                            router.refresh();
                        })
                    }
                >
                    Save
                </Button>
            </div>
        </div>
    );
}

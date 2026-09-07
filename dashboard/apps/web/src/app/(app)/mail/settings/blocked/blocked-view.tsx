"use client";

/**
 * Who this mailbox refuses, and what refusing actually does.
 *
 * The paragraph at the top is the important part of this screen. There is no
 * block at the protocol level: a message reaches the mailbox before any client
 * sees it, and nothing a client says afterwards stops the next one. Saying so
 * plainly is better than a switch that quietly means something narrower than
 * what it is called.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, ShieldOff } from "lucide-react";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { Button, EmptyState, useToast } from "@polaris/ui";
import type { BlockedSender } from "@/lib/mailbox/blocking";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { unblockSenderAction } from "@/app/(app)/mail/actions";

export function BlockedView({
    accounts,
    blocked
}: {
    accounts: MailAccountView[];
    blocked: Record<string, BlockedSender[]>;
}) {
    const router = useRouter();
    const toast = useToast();
    const [busy, startBusy] = useTransition();
    const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0];
    const list = account ? (blocked[account.id] ?? []) : [];

    if (!account) {
        return (
            <EmptyState
                icon={<Ban className="size-5 shrink-0" aria-hidden />}
                title="No mailbox yet"
                description="Connect one and you can start refusing senders on it."
            />
        );
    }

    return (
        <div>
            <AccountPicker accounts={accounts} value={account.id} onChange={setAccountId} />

            <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                Mail cannot be refused before it arrives. A message is delivered to your mailbox by the
                sending server long before Polaris sees it, and no mail client can stop that - only your
                provider can. So a block here means the next best thing: everything from that address goes
                straight to the trash and never reaches your inbox. It still arrives and it still counts
                against your mailbox, but you never see it, and it goes somewhere you can get it back from
                rather than somewhere you cannot.
            </p>

            <section className="mt-4">
                <h2 className="text-[13px] font-medium">Blocked senders</h2>
                {list.length === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        Nobody. Blocking one from a message adds them here.
                    </p>
                ) : (
                    <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                        {list.map((one) => (
                            <li key={one.ruleId} className="flex items-center gap-3 px-3 py-2">
                                <ShieldOff className="size-4 shrink-0 text-foreground-subtle" aria-hidden />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px]" title={one.address}>
                                        {one.address}
                                    </span>
                                    <span className="block text-[12px] text-foreground-subtle">
                                        {one.as === "junk" ? "Straight to spam" : "Straight to the trash"}
                                        {one.caught > 0
                                            ? ` - ${one.caught} ${one.caught === 1 ? "message" : "messages"} so far`
                                            : " - nothing yet"}
                                        {one.enabled ? "" : " - switched off"}
                                    </span>
                                </span>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                        startBusy(async () => {
                                            const answer = await unblockSenderAction(account.id, one.ruleId);
                                            const said = refusalOf(answer);
                                            if (said) {
                                                toast.show({ title: said });
                                                return;
                                            }
                                            toast.show({ title: `${one.address} is no longer blocked.` });
                                            router.refresh();
                                        })
                                    }
                                >
                                    Unblock
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    Each of these is an ordinary filter, so you can open one in{" "}
                    <Link href="/mail/settings/rules" className="underline">
                        Filters
                    </Link>{" "}
                    to change what happens instead of throwing the mail away.
                </p>
            </section>
        </div>
    );
}

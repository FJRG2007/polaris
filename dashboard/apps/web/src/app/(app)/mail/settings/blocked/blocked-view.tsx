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
import { useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { Button, EmptyState, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("mailSettings");
    const [busy, startBusy] = useBusy();
    const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0];
    const list = account ? (blocked[account.id] ?? []) : [];

    if (!account) {
        return (
            <EmptyState
                icon={<Ban className="size-5 shrink-0" aria-hidden />}
                title={t("blocked.noMailboxTitle")}
                description={t("blocked.noMailboxBody")}
            />
        );
    }

    return (
        <div>
            <AccountPicker accounts={accounts} value={account.id} onChange={setAccountId} />

            <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                {t("blocked.explain")}
            </p>

            <section className="mt-4">
                <h2 className="text-[13px] font-medium">{t("blocked.title")}</h2>
                {list.length === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        {t("blocked.empty")}
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
                                        {one.as === "junk" ? t("blocked.toSpam") : t("blocked.toTrash")}
                                        {t("blocked.caught", { count: one.caught })}
                                        {one.enabled ? "" : t("blocked.off")}
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
                                            toast.show({ title: t("blocked.unblocked", { address: one.address }) });
                                            router.refresh();
                                        })
                                    }
                                >
                                    {t("blocked.unblock")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    {t.rich("blocked.filters", {
                        link: (chunks) => (
                            <Link key="link" href="/mail/settings/rules" className="underline">
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            </section>
        </div>
    );
}

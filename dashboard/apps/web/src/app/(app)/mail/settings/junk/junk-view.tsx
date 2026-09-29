"use client";

/**
 * The junk filter, and what it has learned.
 *
 * The two numbers are the point of the screen. A filter that learns is one
 * people have to decide whether to trust, and the honest way to earn that is to
 * say plainly how much it has been taught and to make forgetting it one press.
 * A classifier whose state is invisible and whose training cannot be undone is
 * one people switch off the first time it is wrong.
 */

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AccountPicker } from "../account-picker";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { useConfirm } from "@/components/confirm-dialog";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, EmptyState, Switch, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { forgetSpamAction, setSpamFilterAction } from "@/app/(app)/mail/actions";

interface Learning {
    junk: number;
    good: number;
    words: number;
}

export function JunkView({
    accounts,
    learning
}: {
    accounts: MailAccountView[];
    learning: Record<string, Learning>;
}) {
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [confirm, confirmDialog] = useConfirm();
    const [busy, startBusy] = useBusy();
    const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
    const [on, setOn] = useState<Record<string, boolean>>(
        Object.fromEntries(accounts.map((one) => [one.id, one.spamFilter]))
    );
    const [taught, setTaught] = useState(learning);

    const account = accounts.find((one) => one.id === accountId) ?? accounts[0];
    if (!account) {
        return (
            <EmptyState
                icon={<ShieldCheck className="size-5 shrink-0" aria-hidden />}
                title={t("blocked.noMailboxTitle")}
                description={t("junk.noMailbox")}
            />
        );
    }

    const state = taught[account.id] ?? { junk: 0, good: 0, words: 0 };
    const enabled = on[account.id] ?? account.spamFilter;

    function toggle(next: boolean): void {
        setOn((held) => ({ ...held, [account!.id]: next }));
        startBusy(async () => {
            const answer = await setSpamFilterAction(account!.id, next);
            const said = refusalOf(answer);
            if (said) {
                setOn((held) => ({ ...held, [account!.id]: !next }));
                toast.show({ title: said });
            }
        });
    }

    async function forget(): Promise<void> {
        const sure = await confirm({
            title: t("junk.forgetTitle"),
            description: t("junk.forgetBody"),
            confirmLabel: t("junk.forgetConfirm"),
            danger: true
        });
        if (!sure) return;
        startBusy(async () => {
            const answer = await forgetSpamAction(account!.id);
            const said = refusalOf(answer);
            if (said) {
                toast.show({ title: said });
                return;
            }
            if ("learning" in answer && answer.learning) {
                setTaught((held) => ({ ...held, [account!.id]: answer.learning }));
            }
            toast.show({ title: t("junk.forgotten") });
        });
    }

    return (
        <div>
            <AccountPicker accounts={accounts} value={account.id} onChange={setAccountId} />

            <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                {t("junk.explain")}
            </p>

            <section className="mt-4 rounded-md border border-border">
                <div className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium">{t("junk.judge")}</p>
                        <p className="text-[12px] text-muted-foreground">{t("junk.judgeHint")}</p>
                    </div>
                    <Switch
                        checked={enabled}
                        disabled={busy}
                        onChange={toggle}
                        aria-label={t("junk.judge")}
                    />
                </div>
                <p className="border-t border-border px-3 py-2 text-[12px] text-foreground-subtle">
                    {t("junk.offHint")}
                </p>
            </section>

            <section className="mt-4">
                <h2 className="text-[13px] font-medium">{t("junk.learned")}</h2>
                {state.junk + state.good === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        {t("junk.nothingYet")}
                    </p>
                ) : (
                    <>
                        <p className="mt-1 text-[13px]">
                            {t("junk.counts", { junk: state.junk, good: state.good, words: state.words })}
                        </p>
                        <p className="mt-1 text-[12px] text-foreground-subtle">
                            {t("junk.changeMind")}
                        </p>
                    </>
                )}
                {state.junk + state.good > 0 ? (
                    <Button
                        className="mt-2"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void forget()}
                    >
                        {t("junk.forgetAll")}
                    </Button>
                ) : null}
            </section>
            {confirmDialog}
        </div>
    );
}

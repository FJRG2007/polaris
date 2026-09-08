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

import { ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { useConfirm } from "@/components/confirm-dialog";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, EmptyState, Switch, useToast } from "@polaris/ui";
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
    const [confirm, confirmDialog] = useConfirm();
    const [busy, startBusy] = useTransition();
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
                title="No mailbox yet"
                description="Connect one and Polaris can start judging what arrives in it."
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
            title: "Forget what this filter has learned?",
            description:
                "Every Junk and Not junk you have pressed on this mailbox is taken back, and it starts again knowing nothing about your mail. Nothing moves: what is in Junk stays in Junk.",
            confirmLabel: "Forget it",
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
            toast.show({ title: "It starts again from nothing." });
        });
    }

    return (
        <div>
            <AccountPicker accounts={accounts} value={account.id} onChange={setAccountId} />

            <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                Your provider filters this mailbox before Polaris ever sees it, so what this catches
                is what got through - and it catches it using things your provider cannot know: who
                you write to, what you have already called junk, and what you fished back out. It
                runs here, on this machine. Nothing about your mail is sent anywhere to be scored.
            </p>

            <section className="mt-4 rounded-md border border-border">
                <div className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium">Judge arriving mail</p>
                        <p className="text-[12px] text-muted-foreground">
                            Anything clearly junk goes to the Junk folder. Anything only doubtful
                            stays where it is and says so when you open it.
                        </p>
                    </div>
                    <Switch
                        checked={enabled}
                        disabled={busy}
                        onChange={toggle}
                        aria-label="Judge arriving mail"
                    />
                </div>
                <p className="border-t border-border px-3 py-2 text-[12px] text-foreground-subtle">
                    Switching this off changes what happens to mail arriving afterwards. It never
                    moves or re-reads what is already here.
                </p>
            </section>

            <section className="mt-4">
                <h2 className="text-[13px] font-medium">What it has learned</h2>
                {state.junk + state.good === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        Nothing yet. Pressing Junk on a message teaches it, and Not junk on one in
                        the Junk folder teaches it the other way. Until then it goes on what it can
                        check: who the sending server says the message is from, where its links go,
                        and whether you have written to the sender.
                    </p>
                ) : (
                    <>
                        <p className="mt-1 text-[13px]">
                            {state.junk} marked as junk, {state.good} marked as not junk, and{" "}
                            {state.words} {state.words === 1 ? "word" : "words"} it has an opinion
                            about.
                        </p>
                        <p className="mt-1 text-[12px] text-foreground-subtle">
                            Changing your mind about a message takes the first answer back, so
                            pressing the wrong one is not permanent.
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
                        Forget it all
                    </Button>
                ) : null}
            </section>
            {confirmDialog}
        </div>
    );
}

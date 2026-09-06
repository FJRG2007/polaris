"use client";

/**
 * The away message.
 *
 * The screen says out loud what it will not answer, because that is the part
 * people worry about and the part that goes wrong in other clients: a mailing
 * list, a bounce, another machine's auto-reply, and anybody it has already
 * answered inside the window. Saying so is what makes somebody willing to turn
 * it on.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { setVacationAction } from "@/app/(app)/mail/actions";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, Input, Switch, Textarea, useToast } from "@polaris/ui";

interface Vacation {
    enabled: boolean;
    subject: string;
    body: string;
    startsAt: string;
    endsAt: string;
    repeatDays: number;
}

export function AwayView({
    accounts,
    vacations
}: {
    accounts: MailAccountView[];
    vacations: Record<string, Vacation>;
}) {
    const router = useRouter();
    const toast = useToast();
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const held = vacations[account.id]!;

    const [form, setForm] = useState<Vacation>(held);
    const [problem, setProblem] = useState("");
    const [saving, startSaving] = useTransition();

    function pick(next: string): void {
        const chosen = vacations[next];
        if (!chosen) return;
        setAccountId(next);
        setForm(chosen);
        setProblem("");
    }

    const dirty = JSON.stringify(form) !== JSON.stringify(held);

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={pick} />

            <div className="space-y-3">
                <label className="flex items-center gap-2 text-[13px]">
                    <Switch
                        checked={form.enabled}
                        onChange={(next) => setForm({ ...form, enabled: next })}
                        aria-label="Send an away message"
                    />
                    Answer mail to {account.address} while I am away
                </label>

                <label className="block">
                    <span className="mb-1 block text-[12px] text-muted-foreground">
                        Subject, if you want one other than &quot;Re: their subject&quot;
                    </span>
                    <Input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} />
                </label>

                <label className="block">
                    <span className="mb-1 block text-[12px] text-muted-foreground">
                        What it says {form.enabled ? <span aria-hidden>*</span> : null}
                    </span>
                    <Textarea
                        rows={5}
                        value={form.body}
                        onChange={(event) => setForm({ ...form, body: event.target.value })}
                        placeholder="I am away until the 12th and will answer when I am back."
                    />
                </label>

                <div className="flex flex-wrap gap-3">
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">From</span>
                        <Input
                            type="date"
                            value={form.startsAt}
                            onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">Until</span>
                        <Input
                            type="date"
                            value={form.endsAt}
                            onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            Answer the same person again after
                        </span>
                        <Input
                            type="number"
                            min={1}
                            max={90}
                            className="w-24"
                            value={String(form.repeatDays)}
                            onChange={(event) => setForm({ ...form, repeatDays: Number(event.target.value) })}
                        />
                    </label>
                </div>

                <p className="text-[12px] text-foreground-subtle">
                    Never answered: a mailing list, a bounce, another away message, an address like no-reply, or
                    anybody already answered inside the window above. Being blind-copied on something does not
                    count as being written to.
                </p>

                {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

                <Button
                    disabled={!dirty || saving}
                    onClick={() =>
                        startSaving(async () => {
                            setProblem("");
                            const answer = await setVacationAction(account.id, {
                                enabled: form.enabled,
                                subject: form.subject,
                                body: form.body,
                                startsAt: form.startsAt || null,
                                endsAt: form.endsAt || null,
                                repeatDays: form.repeatDays
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                setProblem(said);
                                return;
                            }
                            toast.show({ title: form.enabled ? "Away message is on." : "Away message is off." });
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

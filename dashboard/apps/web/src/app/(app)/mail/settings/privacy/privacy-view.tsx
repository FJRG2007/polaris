"use client";

/**
 * What a message is allowed to do when it is opened.
 *
 * Written so somebody can read the screen and understand what they are choosing
 * rather than what the setting is called. "Block remote content" means nothing
 * to most people; "a message can tell its sender you opened it, and this stops
 * it" means something to everybody.
 *
 * Pictures are shown by default, and that is not a retreat. Every outside
 * address in a message is fetched by Polaris and served from here, so a sender
 * learns that a server asked and nothing about the reader - which means the
 * click that used to stand between somebody and their own mail was buying
 * nothing. The stricter settings stay for anybody who wants no fetch at all.
 */

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { Button, Select, Switch, useToast } from "@polaris/ui";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { setPrivacyAction, trustSenderAction } from "@/app/(app)/mail/actions";

/** What switching it on means, before anybody chooses otherwise. Long enough
 *  that a code is dead several times over, short enough to be worth having. */
const DEFAULT_KEEP_MINUTES = 60;

/** The waits worth offering. Anything finer is somebody counting minutes at a
 *  mailbox, which is not a thing people do. */
const KEEP_CHOICES: readonly { minutes: number; label: string }[] = [
    { minutes: 15, label: "After 15 minutes" },
    { minutes: 60, label: "After an hour" },
    { minutes: 60 * 6, label: "After six hours" },
    { minutes: 60 * 24, label: "After a day" },
    { minutes: 60 * 24 * 7, label: "After a week" }
];

const MODES = [
    {
        value: "block",
        title: "Never load anything from outside",
        body: "The strictest. Some messages will look broken, because they are mostly pictures."
    },
    {
        value: "trusted",
        title: "Only from senders I have allowed",
        body: "Stricter than it needs to be now that pictures come through Polaris, and slower to read: nothing is drawn until you allow that sender."
    },
    {
        value: "always",
        title: "Show pictures",
        body: "The usual choice. Polaris fetches them on your behalf, so the sender never learns your address, your browser, or when you opened it."
    }
] as const;

export function PrivacyView({
    accounts,
    trusted
}: {
    accounts: MailAccountView[];
    trusted: Record<string, string[]>;
}) {
    const router = useRouter();
    const toast = useToast();
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const [saving, startSaving] = useTransition();

    const [remoteContent, setRemoteContent] = useState(account.remoteContent);
    const [nameTrackers, setNameTrackers] = useState(account.nameTrackers);
    const [answerReceipts, setAnswerReceipts] = useState(account.answerReceipts);
    const [cleanLinks, setCleanLinks] = useState(account.cleanLinks);
    const [keepCodes, setKeepCodes] = useState(account.securityKeepMinutes);

    function pick(next: string): void {
        const chosen = accounts.find((one) => one.id === next);
        if (!chosen) return;
        setAccountId(next);
        setRemoteContent(chosen.remoteContent);
        setNameTrackers(chosen.nameTrackers);
        setAnswerReceipts(chosen.answerReceipts);
        setCleanLinks(chosen.cleanLinks);
        setKeepCodes(chosen.securityKeepMinutes);
    }

    const dirty =
        remoteContent !== account.remoteContent ||
        nameTrackers !== account.nameTrackers ||
        answerReceipts !== account.answerReceipts ||
        cleanLinks !== account.cleanLinks ||
        keepCodes !== account.securityKeepMinutes;

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={pick} />

            <section className="space-y-2">
                <h2 className="text-[13px] font-medium">Pictures and anything else a message loads</h2>
                <p className="text-[12px] text-muted-foreground">
                    A message can carry an invisible picture that tells its sender the moment you opened it, from
                    where, and on what. Polaris fetches every one of them for you, so what they get is a request
                    from this server rather than anything about you.
                </p>
                <ul className="space-y-1.5">
                    {MODES.map((mode) => (
                        <li key={mode.value}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2">
                                <input
                                    type="radio"
                                    name="remote-content"
                                    className="mt-0.5"
                                    checked={remoteContent === mode.value}
                                    onChange={() => setRemoteContent(mode.value)}
                                />
                                <span className="min-w-0">
                                    <span className="block text-[13px] text-foreground">{mode.title}</span>
                                    <span className="block text-[12px] text-muted-foreground">{mode.body}</span>
                                </span>
                            </label>
                        </li>
                    ))}
                </ul>
            </section>

            <section className="mt-4 space-y-3">
                <label className="flex items-start gap-2">
                    <Switch checked={nameTrackers} onChange={setNameTrackers} aria-label="Name the trackers" />
                    <span className="min-w-0">
                        <span className="block text-[13px]">Say which companies were tracking</span>
                        <span className="block text-[12px] text-muted-foreground">
                            A message says how many trackers it carried and who they belong to, rather than only
                            that something was blocked.
                        </span>
                    </span>
                </label>

                <label className="flex items-start gap-2">
                    <Switch checked={cleanLinks} onChange={setCleanLinks} aria-label="Clean links" />
                    <span className="min-w-0">
                        <span className="block text-[13px]">Take the tracking out of links</span>
                        <span className="block text-[12px] text-muted-foreground">
                            A link still goes where it says it goes; it stops carrying who followed it.
                        </span>
                    </span>
                </label>

                <label className="flex items-start gap-2">
                    <Switch
                        checked={answerReceipts}
                        onChange={setAnswerReceipts}
                        aria-label="Answer read receipts"
                    />
                    <span className="min-w-0">
                        <span className="block text-[13px]">Answer read receipts</span>
                        <span className="block text-[12px] text-muted-foreground">
                            Off, a sender who asks to be told you read their message is not told. Polaris still
                            shows you that they asked.
                        </span>
                    </span>
                </label>

                <label className="flex items-start gap-2">
                    <Switch
                        checked={keepCodes > 0}
                        onChange={(on) => setKeepCodes(on ? DEFAULT_KEEP_MINUTES : 0)}
                        aria-label="Throw away codes once they have expired"
                    />
                    <span className="min-w-0">
                        <span className="block text-[13px]">Throw away codes once they have expired</span>
                        <span className="block text-[12px] text-muted-foreground">
                            A verification code stops working in a few minutes and then sits in your mailbox
                            for years. Off by default: this deletes mail, so it is something to switch on
                            rather than something to switch off.
                        </span>
                        {keepCodes > 0 ? (
                            <span className="mt-1.5 flex items-center gap-2">
                                <Select
                                    value={String(keepCodes)}
                                    onValueChange={(next) => setKeepCodes(Number(next))}
                                    aria-label="How long a code is kept"
                                    className="h-7 w-44 text-[12px]"
                                    options={KEEP_CHOICES.map((one) => ({
                                        value: String(one.minutes),
                                        label: one.label
                                    }))}
                                />
                                <span className="text-[12px] text-foreground-subtle">
                                    then to the trash, where you can still get it back.
                                </span>
                            </span>
                        ) : null}
                    </span>
                </label>

                <Button
                    disabled={!dirty || saving}
                    onClick={() =>
                        startSaving(async () => {
                            const answer = await setPrivacyAction(account.id, {
                                remoteContent,
                                nameTrackers,
                                answerReceipts,
                                cleanLinks,
                                securityKeepMinutes: keepCodes
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({ title: "Saved." });
                            router.refresh();
                        })
                    }
                >
                    Save
                </Button>
            </section>

            <section className="mt-6">
                <h2 className="text-[13px] font-medium">Senders whose pictures load</h2>
                {(trusted[account.id] ?? []).length === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        Nobody yet. Allowing a sender from inside a message adds them here.
                    </p>
                ) : (
                    <ul className="mt-2 flex flex-wrap gap-2">
                        {(trusted[account.id] ?? []).map((address) => (
                            <li
                                key={address}
                                className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[12px]"
                            >
                                <span className="max-w-[16rem] truncate" title={address}>{address}</span>
                                <button
                                    type="button"
                                    aria-label={`Stop loading pictures from ${address}`}
                                    title={`Stop loading pictures from ${address}`}
                                    className="text-foreground-subtle hover:text-foreground"
                                    onClick={() =>
                                        void (async () => {
                                            const answer = await trustSenderAction(account.id, {
                                                address,
                                                trusted: false
                                            });
                                            const said = refusalOf(answer);
                                            if (said) {
                                                toast.show({ title: said });
                                                return;
                                            }
                                            router.refresh();
                                        })()
                                    }
                                >
                                    <X className="size-3.5 shrink-0" aria-hidden />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

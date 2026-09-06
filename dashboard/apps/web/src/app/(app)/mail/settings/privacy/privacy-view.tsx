"use client";

/**
 * What a message is allowed to do when it is opened.
 *
 * Written so somebody can read the screen and understand what they are choosing
 * rather than what the setting is called. "Block remote content" means nothing
 * to most people; "a message can tell its sender you opened it, and this stops
 * it" means something to everybody.
 *
 * The default is the middle one - nothing loads until you say a particular
 * sender is fine - because it is the only setting that survives contact with a
 * real inbox. Blocking everything for ever makes half of somebody's mail
 * unreadable, and allowing everything is the thing this app exists not to do.
 */

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { Button, Switch, useToast } from "@polaris/ui";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { setPrivacyAction, trustSenderAction } from "@/app/(app)/mail/actions";

const MODES = [
    {
        value: "block",
        title: "Never load anything from outside",
        body: "The strictest. Some messages will look broken, because they are mostly pictures."
    },
    {
        value: "trusted",
        title: "Only from senders I have allowed",
        body: "Nothing loads until you say a particular sender is fine, one message at a time."
    },
    {
        value: "always",
        title: "Always load pictures",
        body: "Convenient, and it tells every sender when you open their message."
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

    function pick(next: string): void {
        const chosen = accounts.find((one) => one.id === next);
        if (!chosen) return;
        setAccountId(next);
        setRemoteContent(chosen.remoteContent);
        setNameTrackers(chosen.nameTrackers);
        setAnswerReceipts(chosen.answerReceipts);
        setCleanLinks(chosen.cleanLinks);
    }

    const dirty =
        remoteContent !== account.remoteContent ||
        nameTrackers !== account.nameTrackers ||
        answerReceipts !== account.answerReceipts ||
        cleanLinks !== account.cleanLinks;

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={pick} />

            <section className="space-y-2">
                <h2 className="text-[13px] font-medium">Pictures and anything else a message loads</h2>
                <p className="text-[12px] text-muted-foreground">
                    A message can carry an invisible picture that tells its sender the moment you opened it, from
                    where, and on what. Polaris does not fetch any of it until you say so.
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

                <Button
                    disabled={!dirty || saving}
                    onClick={() =>
                        startSaving(async () => {
                            const answer = await setPrivacyAction(account.id, {
                                remoteContent,
                                nameTrackers,
                                answerReceipts,
                                cleanLinks
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

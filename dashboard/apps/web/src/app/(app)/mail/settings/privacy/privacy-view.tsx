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
import { useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { Button, Select, Switch, useToast } from "@polaris/ui";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { setPrivacyAction, trustSenderAction } from "@/app/(app)/mail/actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What switching it on means, before anybody chooses otherwise. Long enough
 *  that a code is dead several times over, short enough to be worth having. */
const DEFAULT_KEEP_MINUTES = 60;

/** The waits worth offering. Anything finer is somebody counting minutes at a
 *  mailbox, which is not a thing people do. */
/** How long a code may be kept, each named in `mailSettings.privacy.keep.<id>`. */
const KEEP_CHOICES: readonly { minutes: number; id: "quarter" | "hour" | "sixHours" | "day" | "week" }[] = [
    { minutes: 15, id: "quarter" },
    { minutes: 60, id: "hour" },
    { minutes: 60 * 6, id: "sixHours" },
    { minutes: 60 * 24, id: "day" },
    { minutes: 60 * 24 * 7, id: "week" }
];

/** The choices for what a message may load, each worded in `mailSettings.privacy.modes.<value>`. */
const MODES = ["block", "trusted", "always"] as const;

export function PrivacyView({
    accounts,
    trusted
}: {
    accounts: MailAccountView[];
    trusted: Record<string, string[]>;
}) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tc = useTranslations("common");
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const [saving, startSaving] = useBusy();

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
                <h2 className="text-[13px] font-medium">{t("privacy.title")}</h2>
                <p className="text-[12px] text-muted-foreground">{t("privacy.lead")}</p>
                <ul className="space-y-1.5">
                    {MODES.map((mode) => (
                        <li key={mode}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2">
                                <input
                                    type="radio"
                                    name="remote-content"
                                    className="mt-0.5"
                                    checked={remoteContent === mode}
                                    onChange={() => setRemoteContent(mode)}
                                />
                                <span className="min-w-0">
                                    <span className="block text-[13px] text-foreground">
                                        {t(`privacy.modes.${mode}.title`)}
                                    </span>
                                    <span className="block text-[12px] text-muted-foreground">
                                        {t(`privacy.modes.${mode}.body`)}
                                    </span>
                                </span>
                            </label>
                        </li>
                    ))}
                </ul>
            </section>

            <section className="mt-4 space-y-3">
                <label className="flex items-start gap-2">
                    <Switch checked={nameTrackers} onChange={setNameTrackers} aria-label={t("privacy.nameTrackersLabel")} />
                    <span className="min-w-0">
                        <span className="block text-[13px]">{t("privacy.nameTrackers")}</span>
                        <span className="block text-[12px] text-muted-foreground">{t("privacy.nameTrackersHint")}</span>
                    </span>
                </label>

                <label className="flex items-start gap-2">
                    <Switch checked={cleanLinks} onChange={setCleanLinks} aria-label={t("privacy.cleanLinksLabel")} />
                    <span className="min-w-0">
                        <span className="block text-[13px]">{t("privacy.cleanLinks")}</span>
                        <span className="block text-[12px] text-muted-foreground">{t("privacy.cleanLinksHint")}</span>
                    </span>
                </label>

                <label className="flex items-start gap-2">
                    <Switch
                        checked={answerReceipts}
                        onChange={setAnswerReceipts}
                        aria-label={t("privacy.receipts")}
                    />
                    <span className="min-w-0">
                        <span className="block text-[13px]">{t("privacy.receipts")}</span>
                        <span className="block text-[12px] text-muted-foreground">{t("privacy.receiptsHint")}</span>
                    </span>
                </label>

                <label className="flex items-start gap-2">
                    <Switch
                        checked={keepCodes > 0}
                        onChange={(on) => setKeepCodes(on ? DEFAULT_KEEP_MINUTES : 0)}
                        aria-label={t("privacy.codes")}
                    />
                    <span className="min-w-0">
                        <span className="block text-[13px]">{t("privacy.codes")}</span>
                        <span className="block text-[12px] text-muted-foreground">{t("privacy.codesHint")}</span>
                        {keepCodes > 0 ? (
                            <span className="mt-1.5 flex items-center gap-2">
                                <Select
                                    value={String(keepCodes)}
                                    onValueChange={(next) => setKeepCodes(Number(next))}
                                    aria-label={t("privacy.keepLabel")}
                                    className="h-7 w-44 text-[12px]"
                                    options={KEEP_CHOICES.map((one) => ({
                                        value: String(one.minutes),
                                        label: t(`privacy.keep.${one.id}`)
                                    }))}
                                />
                                <span className="text-[12px] text-foreground-subtle">
                                    {t("privacy.thenTrash")}
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
                            toast.show({ title: t("general.saved") });
                            router.refresh();
                        })
                    }
                >
                    {tc("actions.save")}
                </Button>
            </section>

            <section className="mt-6">
                <h2 className="text-[13px] font-medium">{t("privacy.trusted")}</h2>
                {(trusted[account.id] ?? []).length === 0 ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        {t("privacy.trustedEmpty")}
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
                                    aria-label={t("privacy.untrust", { address })}
                                    title={t("privacy.untrust", { address })}
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

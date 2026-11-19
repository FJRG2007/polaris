"use client";

/**
 * A conversation's own privacy: read receipts, typing and disappearing
 * messages, drawn in a group's settings dialog. Everything here follows the
 * rules the server hands back (`directRulesAction`), which asks the same
 * questions every write does: a member of a group who does not run it sees the
 * values and the reason, never a control the server would refuse.
 */

import { useState } from "react";
import { Button, Select } from "@polaris/ui";
import { durationName } from "./vanish-controls";
import type { DirectRulesView } from "@/lib/chat/vanish";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CHAT_PRIVACY_RULES, VANISH_DURATIONS, type ChatPrivacyRule } from "@/lib/chat/vanish-rules";

export interface ChatRulesChange {
    readonly receipts?: ChatPrivacyRule;
    readonly typing?: ChatPrivacyRule;
    readonly vanishAfter?: number;
}

export function ChatPrivacySection({
    rules,
    proposerName,
    onChange,
    onAnswer,
    onWithdraw
}: {
    rules: DirectRulesView;
    /** Who made the proposal waiting, as this reader calls them. */
    proposerName: string;
    onChange: (change: ChatRulesChange) => void;
    onAnswer: (proposalId: string, accept: boolean) => Promise<void>;
    onWithdraw: (proposalId: string) => Promise<void>;
}) {
    const t = useTranslations("chat");
    const [busy, setBusy] = useState(false);
    const proposal = rules.proposal;
    const ruleLabel = (rule: ChatPrivacyRule) => t(`chatPrivacy.${rule}`);
    const timerLabel = (seconds: number) => t(`vanish.duration.${durationName(seconds)}`);
    const ruleOptions = CHAT_PRIVACY_RULES.map((rule) => ({ value: rule, label: ruleLabel(rule) }));
    const rows = [
        {
            key: "receipts",
            label: t("chatPrivacy.receipts"),
            value: rules.receipts,
            shown: ruleLabel(rules.receipts),
            proposed:
                proposal && proposal.receipts !== rules.receipts ? ruleLabel(proposal.receipts) : null,
            options: ruleOptions,
            pick: (value: string) => onChange({ receipts: value as ChatPrivacyRule })
        },
        {
            key: "typing",
            label: t("chatPrivacy.typing"),
            value: rules.typing,
            shown: ruleLabel(rules.typing),
            proposed: proposal && proposal.typing !== rules.typing ? ruleLabel(proposal.typing) : null,
            options: ruleOptions,
            pick: (value: string) => onChange({ typing: value as ChatPrivacyRule })
        },
        {
            key: "timer",
            label: t("chatPrivacy.timer"),
            value: String(rules.vanishAfter),
            shown: timerLabel(rules.vanishAfter),
            proposed:
                proposal && proposal.vanishAfter !== rules.vanishAfter
                    ? timerLabel(proposal.vanishAfter)
                    : null,
            options: VANISH_DURATIONS.map((seconds) => ({
                value: String(seconds),
                label: timerLabel(seconds)
            })),
            pick: (value: string) => onChange({ vanishAfter: Number(value) })
        }
    ];
    const hint = !rules.mayChange
        ? t("chatPrivacy.groupAdminsOnly")
        : rules.proposes
          ? t("chatPrivacy.proposed")
          : t("chatPrivacy.announced");
    const settle = (work: Promise<void>) => {
        setBusy(true);
        void work.finally(() => setBusy(false));
    };

    return (
        <section aria-labelledby="chat-privacy-title" className="flex flex-col gap-2 px-4 py-3">
            <div>
                <h3 id="chat-privacy-title" className="text-xs font-semibold uppercase text-muted-foreground">
                    {t("chatPrivacy.title")}
                </h3>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                    <li key={row.key} className="flex flex-col gap-1">
                        <span className="min-w-0 break-words text-[0.8125rem]">{row.label}</span>
                        {rules.mayChange ? (
                            <Select
                                className="h-8 w-full text-xs"
                                aria-label={row.label}
                                value={row.value}
                                disabled={busy}
                                options={row.options}
                                onValueChange={row.pick}
                            />
                        ) : (
                            <span className="min-w-0 break-words text-xs text-muted-foreground">
                                {row.shown}
                            </span>
                        )}
                        {row.proposed ? (
                            <span className="min-w-0 break-words text-xs text-warning">
                                {t("chatPrivacy.proposal", { value: row.proposed })}
                            </span>
                        ) : null}
                    </li>
                ))}
            </ul>
            {proposal && (proposal.mayAnswer || proposal.mine) ? (
                <div role="status" className="flex flex-col gap-2 rounded-md border border-border p-2">
                    <p className="min-w-0 break-words text-xs">
                        {proposal.mine
                            ? t("chatPrivacy.proposalMine")
                            : t("chatPrivacy.proposalBy", { name: proposerName })}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {proposal.mine ? (
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => settle(onWithdraw(proposal.id))}
                            >
                                {t("chatPrivacy.withdraw")}
                            </Button>
                        ) : (
                            <>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => settle(onAnswer(proposal.id, false))}
                                >
                                    {t("chatPrivacy.decline")}
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => settle(onAnswer(proposal.id, true))}
                                >
                                    {t("chatPrivacy.accept")}
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            ) : null}
        </section>
    );
}

"use client";

/**
 * How direct conversations decide their rules (disappearing messages and
 * deleting a chat for everybody), and whether deleting one for everybody leaves
 * a line. See `lib/chat/vanish`.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import type { StartingRules } from "@/lib/chat/vanish";
import { durationName } from "@/app/(app)/chat/vanish-controls";
import { CHAT_PRIVACY_RULES, VANISH_DURATIONS, type ChatPrivacyRule, type DmRuleMode } from "@/lib/chat/vanish-rules";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    setDeleteChatLineAction,
    setDirectThreadsAction,
    setDmRuleModeAction,
    setStartingRulesAction
} from "./actions";
import { Select, SegmentedControl, Switch, useOptimisticToggle } from "@polaris/ui";

export function DirectRulesView({
    mode,
    line,
    threads,
    starting
}: {
    mode: DmRuleMode;
    line: boolean;
    threads: boolean;
    starting: StartingRules;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("chat");
    const [start, setStart] = useState<StartingRules>(starting);
    const [savingStart, setSavingStart] = useState<keyof StartingRules | null>(null);
    const [chosen, setChosen] = useState<DmRuleMode>(mode);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [shown, toggle] = useOptimisticToggle(
        line,
        async (next) => {
            setError("");
            return (await runAction(() => setDeleteChatLineAction(next), setError)) ?? { error: true };
        },
        { onRefused: setError }
    );
    const [threadsOn, toggleThreads] = useOptimisticToggle(
        threads,
        async (next) => {
            setError("");
            return (await runAction(() => setDirectThreadsAction(next), setError)) ?? { error: true };
        },
        { onRefused: setError }
    );

    const change = async (next: DmRuleMode) => {
        if (saving || next === chosen) return;
        setSaving(true);
        setError("");
        const was = chosen;
        setChosen(next);
        const result = await runAction(() => setDmRuleModeAction(next), setError);
        setSaving(false);
        if (!result || result.error) setChosen(was);
    };

    // Optimistic: the choice shows at once and goes back if the save is refused.
    const changeStart = async (patch: Partial<StartingRules>) => {
        const field = Object.keys(patch)[0] as keyof StartingRules;
        if (savingStart || start[field] === patch[field]) return;
        const was = start;
        setStart({ ...start, ...patch });
        setSavingStart(field);
        setError("");
        const result = await runAction(() => setStartingRulesAction(patch), setError);
        setSavingStart(null);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setStart(was);
        }
    };
    const ruleOptions = CHAT_PRIVACY_RULES.map((rule) => ({
        value: rule,
        label: t(`chat.directRules.starting.${rule}`)
    }));
    const timerOptions = [
        { value: "account", label: t("chat.directRules.starting.timerAccount") },
        ...VANISH_DURATIONS.map((seconds) => ({
            value: String(seconds),
            label: tc(`vanish.duration.${durationName(seconds)}`)
        }))
    ];
    const startRows = [
        {
            key: "receipts" as const,
            label: t("chat.directRules.starting.receipts"),
            value: start.receipts,
            options: ruleOptions,
            pick: (value: string) => void changeStart({ receipts: value as ChatPrivacyRule })
        },
        {
            key: "typing" as const,
            label: t("chat.directRules.starting.typing"),
            value: start.typing,
            options: ruleOptions,
            pick: (value: string) => void changeStart({ typing: value as ChatPrivacyRule })
        },
        {
            key: "vanishAfter" as const,
            label: t("chat.directRules.starting.timer"),
            value: start.vanishAfter === null ? "account" : String(start.vanishAfter),
            options: timerOptions,
            pick: (value: string) =>
                void changeStart({ vanishAfter: value === "account" ? null : Number(value) })
        }
    ];

    return (
        <div className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <div>
                    <p className="text-sm font-medium">{t("chat.directRules.title")}</p>
                    <p className="text-xs text-muted-foreground">
                        {chosen === "open"
                            ? t("chat.directRules.open.hint")
                            : t("chat.directRules.agreement.hint")}
                    </p>
                </div>
                <SegmentedControl
                    className="self-start"
                    aria-label={t("chat.directRules.title")}
                    value={chosen}
                    onValueChange={(next) => void change(next as DmRuleMode)}
                    options={[
                        { value: "open", label: t("chat.directRules.open.label") },
                        { value: "agreement", label: t("chat.directRules.agreement.label") }
                    ]}
                />
            </div>
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("chat.directRules.line.label")}</p>
                    <p className="text-xs text-muted-foreground">{t("chat.directRules.line.hint")}</p>
                </div>
                <Switch checked={shown} onChange={toggle} aria-label={t("chat.directRules.line.label")} />
            </div>
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("chat.directRules.threads.label")}</p>
                    <p className="text-xs text-muted-foreground">{t("chat.directRules.threads.hint")}</p>
                </div>
                <Switch
                    checked={threadsOn}
                    onChange={toggleThreads}
                    aria-label={t("chat.directRules.threads.label")}
                />
            </div>
            <div className="flex flex-col gap-2">
                <div>
                    <p className="text-sm font-medium">{t("chat.directRules.starting.title")}</p>
                    <p className="text-xs text-muted-foreground">{t("chat.directRules.starting.hint")}</p>
                </div>
                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                    {startRows.map((row) => (
                        <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                            <span className="min-w-0 flex-1 text-[0.8125rem] sm:min-w-[12rem]">{row.label}</span>
                            <Select
                                className="h-8 w-full shrink-0 text-xs sm:w-64"
                                aria-label={row.label}
                                value={row.value}
                                disabled={savingStart === row.key}
                                options={row.options}
                                onValueChange={row.pick}
                            />
                        </li>
                    ))}
                </ul>
            </div>
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

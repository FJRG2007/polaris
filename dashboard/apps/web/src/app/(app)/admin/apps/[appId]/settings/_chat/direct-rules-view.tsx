"use client";

/**
 * How direct conversations decide their rules (disappearing messages and
 * deleting a chat for everybody), and whether deleting one for everybody leaves
 * a line. See `lib/chat/vanish`.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import type { DmRuleMode } from "@/lib/chat/vanish-rules";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setDeleteChatLineAction, setDmRuleModeAction } from "./actions";
import { SegmentedControl, Switch, useOptimisticToggle } from "@polaris/ui";

export function DirectRulesView({ mode, line }: { mode: DmRuleMode; line: boolean }) {
    const t = useTranslations("admin");
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
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

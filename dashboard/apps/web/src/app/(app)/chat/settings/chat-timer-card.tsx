"use client";

/**
 * The disappearing timer every direct message this account starts begins
 * with. Saved as soon as it is picked, and put back if the save is refused.
 */

import { useState } from "react";
import { Timer } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveChatTimerAction } from "@/app/(app)/account/privacy/actions";
import { Card, CardBody, Select } from "@polaris/ui";
import { VANISH_DURATIONS } from "@/lib/chat/vanish-rules";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { durationName } from "@/app/(app)/chat/vanish-controls";

export function ChatTimerCard({ seconds }: { seconds: number }) {
    const t = useTranslations("accountPrivacy");
    const chat = useTranslations("chat");
    const [value, setValue] = useState(seconds);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const choose = async (next: number) => {
        if (next === value) return;
        const before = value;
        setValue(next);
        setError("");
        setSaving(true);
        const result = await runAction(() => saveChatTimerAction(next), setError);
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setValue(before);
        }
    };

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <Timer className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-[14rem] flex-1">
                    <span className="block text-[0.8125rem]">{t("chatTimer.label")}</span>
                    <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                        {t("chatTimer.hint")}
                    </span>
                    {error && (
                        <span role="alert" className="block text-xs text-danger">
                            {error}
                        </span>
                    )}
                </span>
                <Select
                    className="h-8 w-full shrink-0 text-xs sm:w-48"
                    aria-label={t("chatTimer.label")}
                    value={String(value)}
                    disabled={saving}
                    options={VANISH_DURATIONS.map((duration) => ({
                        value: String(duration),
                        label: chat(`vanish.duration.${durationName(duration)}`)
                    }))}
                    onValueChange={(next) => void choose(Number(next))}
                />
            </CardBody>
        </Card>
    );
}

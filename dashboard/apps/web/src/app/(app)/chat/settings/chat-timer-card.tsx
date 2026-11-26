"use client";

/**
 * The disappearing timer every direct message this account starts begins
 * with. Saved as soon as it is picked, and put back if the save is refused.
 */

import { useState } from "react";
import { Timer } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveChatTimerAction } from "@/app/(app)/account/privacy/actions";
import { Card, CardBody, Select, SettingRow } from "@polaris/ui";
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
            <CardBody className="p-3">
                <SettingRow
                    id="chat-chat-timer"
                    icon={<Timer />}
                    label={t("chatTimer.label")}
                    hint={t("chatTimer.hint")}
                    error={error}
                >
                    <Select
                        className="h-8 w-48 max-w-full"
                        aria-label={t("chatTimer.label")}
                        aria-describedby="chat-chat-timer-hint"
                        value={String(value)}
                        disabled={saving}
                        options={VANISH_DURATIONS.map((duration) => ({
                            value: String(duration),
                            label: chat(`vanish.duration.${durationName(duration)}`)
                        }))}
                        onValueChange={(next) => void choose(Number(next))}
                    />
                </SettingRow>
            </CardBody>
        </Card>
    );
}

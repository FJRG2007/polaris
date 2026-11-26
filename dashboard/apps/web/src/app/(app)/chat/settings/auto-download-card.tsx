"use client";

/**
 * Which pictures in Chat load on their own (ledger row 5,
 * `lib/chat/auto-download`). Saved as soon as it is picked, and put back if
 * the save is refused. "Default" follows the instance's choice, named.
 */

import { useState } from "react";
import { ImageDown } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveAutoDownloadAction } from "@/app/(app)/account/privacy/actions";
import { Card, CardBody, Select, SettingRow } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AUTO_DOWNLOAD_CHOICES, type AutoDownload } from "@/lib/chat/moderation-policy-rules";

const DEFAULT = "default";

export function AutoDownloadCard({ choice, instance }: { choice: AutoDownload | null; instance: AutoDownload }) {
    const t = useTranslations("accountPrivacy");
    const [value, setValue] = useState<string>(choice ?? DEFAULT);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const choose = async (next: string) => {
        if (next === value) return;
        const before = value;
        setValue(next);
        setError("");
        setSaving(true);
        const result = await runAction(() => saveAutoDownloadAction(next === DEFAULT ? null : next), setError);
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
                    id="chat-auto-download"
                    icon={<ImageDown />}
                    label={t("autoDownload.label")}
                    hint={t("autoDownload.hint")}
                    error={error}
                >
                    <Select
                        className="h-8 w-48 max-w-full"
                        aria-label={t("autoDownload.label")}
                        aria-describedby="chat-auto-download-hint"
                        value={value}
                        disabled={saving}
                        options={[
                            {
                                value: DEFAULT,
                                label: t("autoDownload.default", { choice: t(`autoDownload.choice.${instance}`) })
                            },
                            ...AUTO_DOWNLOAD_CHOICES.map((each) => ({
                                value: each,
                                label: t(`autoDownload.choice.${each}`)
                            }))
                        ]}
                        onValueChange={(next) => void choose(next)}
                    />
                </SettingRow>
            </CardBody>
        </Card>
    );
}

"use client";

/**
 * Which pictures in Chat load on their own (ledger row 5,
 * `lib/chat/auto-download`). Saved as soon as it is picked, and put back if
 * the save is refused. "Default" follows the instance's choice, named.
 */

import { useState } from "react";
import { ImageDown } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveAutoDownloadAction } from "./actions";
import { Card, CardBody, Select } from "@polaris/ui";
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
            <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <ImageDown className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-[14rem] flex-1">
                    <span className="block text-[0.8125rem]">{t("autoDownload.label")}</span>
                    <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                        {t("autoDownload.hint")}
                    </span>
                    {error && (
                        <span role="alert" className="block text-xs text-danger">
                            {error}
                        </span>
                    )}
                </span>
                <Select
                    className="h-8 w-full shrink-0 text-xs sm:w-48"
                    aria-label={t("autoDownload.label")}
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
            </CardBody>
        </Card>
    );
}

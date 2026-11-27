"use client";

/**
 * How long a sealed-chat device may go unused before it leaves every
 * conversation it is in (docs/chat-e2ee-mls.md, "Device hygiene"; decision 7:
 * 30 days, 7 to 90). Shown only while sealed chat is on.
 */

import { useState } from "react";
import { setSealedDeviceDaysAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, cn, Select, settingType, useOptimisticValue } from "@polaris/ui";

/** The choices offered: the default and a spread across the allowed 7-90. */
const CHOICES = [7, 14, 30, 45, 60, 90] as const;

export function SealedDevicesForm({ days }: { days: number }) {
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);
    const [value, save, pending] = useOptimisticValue(
        days,
        async (next) => {
            setError(null);
            return setSealedDeviceDaysAction(next);
        },
        { onRefused: setError }
    );
    // A value set before these choices existed still shows as itself.
    const choices = CHOICES.includes(value as (typeof CHOICES)[number]) ? CHOICES : [...CHOICES, value].sort((a, b) => a - b);

    return (
        <Card>
            <CardBody className="flex flex-col divide-y divide-border py-1">
                <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className={settingType.body}>{t("privacy.devices.label")}</span>
                        <span id="privacy-sealed-devices" className={settingType.hint}>
                            {t("privacy.devices.hint")}
                        </span>
                    </div>
                    <Select
                        className={cn(settingType.body, "h-8 w-full shrink-0 sm:w-40")}
                        aria-label={t("privacy.devices.label")}
                        aria-describedby="privacy-sealed-devices"
                        value={String(value)}
                        disabled={pending}
                        options={choices.map((choice) => ({ value: String(choice), label: t("privacy.devices.days", { count: choice }) }))}
                        onValueChange={(next) => {
                            const chosen = Number.parseInt(next, 10);
                            if (Number.isFinite(chosen) && chosen !== value) save(chosen);
                        }}
                    />
                </div>
                {error ? <p className={cn(settingType.error, "py-3")}>{error}</p> : null}
            </CardBody>
        </Card>
    );
}

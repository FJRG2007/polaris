"use client";

/**
 * Quiet hours: a stretch of the day when mail, webhooks and texts hold off.
 * The bell still records everything, so nothing is lost - it just does not
 * buzz a phone at 3am. Read on the account's own clock, which the card names,
 * and critical alerts can be let through.
 */

import { useState, useTransition } from "react";
import { quietHoursSchema, type QuietHours } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { saveQuietHoursAction } from "./actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Switch } from "@polaris/ui";

export function QuietHoursCard({ initial, timeZone }: { initial: QuietHours; timeZone: string }) {
    const t = useTranslations("accountNotifications");
    const [saved, setSaved] = useState(initial);
    const [draft, setDraft] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const checked = quietHoursSchema.safeParse(draft);
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);

    function save() {
        if (!checked.success) return;
        const previous = saved;
        const next = checked.data;
        setError(null);
        setSaved(next);
        startTransition(async () => {
            const result = await saveQuietHoursAction(next);
            if (result.error) {
                setSaved(previous);
                setError(result.error);
            }
        });
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle>{t("quiet.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                        {t("quiet.description", { zone: timeZone })}
                    </p>
                </div>
                <Switch
                    checked={draft.enabled}
                    onChange={(enabled) => setDraft({ ...draft, enabled })}
                    aria-label={t("quiet.toggle")}
                />
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("quiet.from")}</span>
                        <Input
                            type="time"
                            value={draft.start}
                            disabled={!draft.enabled}
                            onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("quiet.until")}</span>
                        <Input
                            type="time"
                            value={draft.end}
                            disabled={!draft.enabled}
                            onChange={(event) => setDraft({ ...draft, end: event.target.value })}
                        />
                    </label>
                </div>
                <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">{t("quiet.critical")}</span>
                    <Switch
                        checked={draft.criticalBypass}
                        disabled={!draft.enabled}
                        onChange={(criticalBypass) => setDraft({ ...draft, criticalBypass })}
                        aria-label={t("quiet.critical")}
                    />
                </label>
                {!checked.success ? (
                    <p className="text-xs text-danger">{t("quiet.invalid")}</p>
                ) : null}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <div className="flex justify-end">
                    <Button
                        size="sm"
                        onClick={save}
                        disabled={pending || !changed || !checked.success}
                    >
                        {t("quiet.save")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

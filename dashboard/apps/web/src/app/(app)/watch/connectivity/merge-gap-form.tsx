"use client";

/**
 * How close together two outages have to be to count as one.
 *
 * A home line that drops for ten seconds three times in a minute had one bad
 * minute, not three outages, and counting it as three makes the history read
 * worse than it was. The gap is the operator's to set; the default is a minute.
 */

import { setMergeGapAction } from "./actions";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MAX_MERGE_GAP_SECONDS, mergeGapSchema } from "@/lib/connectivity/outages";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Skeleton } from "@polaris/ui";

/** What the field holds, as the schema checks it: whole seconds, or nothing. */
function parse(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === "" || !/^\d+$/.test(trimmed)) return trimmed === "" ? null : Number.NaN;
    return Number(trimmed);
}

export function MergeGapForm({
    seconds,
    onSaved
}: {
    /** The stored gap, or null while it is loading. */
    seconds: number | null;
    onSaved: (seconds: number) => void;
}) {
    const t = useTranslations("watch");
    const [text, setText] = useState<string | null>(null);
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
    const [saving, startSave] = useTransition();

    // The field follows the stored value until somebody types in it.
    useEffect(() => {
        if (seconds !== null && text === null) setText(String(seconds));
    }, [seconds, text]);

    const value = text === null ? null : parse(text);
    const empty = value === null;
    const valid = value !== null && mergeGapSchema.safeParse(value).success;
    const dirty = valid && value !== seconds;
    const error = !empty && !valid ? t("connectivity.merge.invalid", { max: MAX_MERGE_GAP_SECONDS }) : null;

    const save = () => {
        if (!dirty || saving || value === null) return;
        const previous = seconds;
        startSave(async () => {
            setMessage(null);
            // Optimistic: the cadence line above changes at once, and goes back if
            // the save does not land.
            onSaved(value);
            const result = await setMergeGapAction(value).catch(
                (): { seconds?: number; error?: string } => ({ error: t("connectivity.merge.failed") })
            );
            if (result.error || result.seconds === undefined) {
                if (previous !== null) onSaved(previous);
                setMessage({ tone: "error", text: result.error ?? t("connectivity.merge.failed") });
                return;
            }
            setText(String(result.seconds));
            setMessage({ tone: "ok", text: t("connectivity.merge.saved") });
        });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("connectivity.merge.title")}</CardTitle>
                <p className="text-xs text-muted-foreground">{t("connectivity.merge.hint")}</p>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        save();
                    }}
                >
                    <label htmlFor="merge-gap" className="text-[0.8125rem] font-medium">
                        {t("connectivity.merge.label")} <span aria-hidden="true">*</span>
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        {text === null ? (
                            <Skeleton className="h-8 w-28" />
                        ) : (
                            <Input
                                id="merge-gap"
                                className="w-28 tabular"
                                inputMode="numeric"
                                autoComplete="off"
                                required
                                value={text}
                                aria-invalid={error !== null}
                                aria-describedby={error ? "merge-gap-error" : undefined}
                                onChange={(event) => {
                                    setMessage(null);
                                    setText(event.target.value);
                                }}
                                onBlur={() => setText((current) => (current === null ? current : current.trim()))}
                            />
                        )}
                        <span className="text-[0.8125rem] text-muted-foreground">{t("connectivity.merge.unit")}</span>
                        <Button
                            type="submit"
                            size="sm"
                            aria-disabled={!dirty || saving}
                            title={!dirty && valid ? t("connectivity.merge.unchanged") : undefined}
                        >
                            {t("connectivity.merge.save")}
                        </Button>
                    </div>
                    {error ? (
                        <p id="merge-gap-error" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : message ? (
                        <p className={message.tone === "ok" ? "text-xs text-success-ink" : "text-xs text-danger"} aria-live="polite">
                            {message.text}
                        </p>
                    ) : null}
                </form>
            </CardBody>
        </Card>
    );
}

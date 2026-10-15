"use client";

/**
 * Whether the open shelf keeps a recycle bin, and for how many days. Shown to
 * everyone who can read Deploy; only somebody who may change it gets live
 * controls, everyone else sees why not.
 */

import { Loader2 } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { setBinPolicyAction } from "./restore-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Input, Switch } from "@polaris/ui";
import type { BinPolicyLock } from "@/lib/deploy/recycle-bin-access";
import { binDaysSchema, type BinPolicy } from "@/lib/deploy/recycle-bin-policy";

export function RecycleBinSettings({
    initial,
    lock,
    orgName
}: {
    initial: BinPolicy;
    lock: BinPolicyLock;
    orgName: string | null;
}) {
    const t = useTranslations("deploySafety");
    const hintId = useId();
    const lockId = useId();
    const [saved, setSaved] = useState(initial);
    const [enabled, setEnabled] = useState(initial.enabled);
    const [daysDraft, setDaysDraft] = useState(String(initial.days));
    const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
    const [pending, startTransition] = useTransition();

    const days = binDaysSchema.safeParse(daysDraft);
    const daysValid = daysDraft !== "" && days.success;
    const dirty = enabled !== saved.enabled || (days.success && days.data !== saved.days);
    const locked = lock !== null;
    const lockText =
        lock === "notOrgAdmin"
            ? t("binSettings.lockNotOrgAdmin", { org: orgName ?? "" })
            : lock === "noDeploy"
              ? t("binSettings.lockNoDeploy")
              : null;

    function save() {
        if (locked || !daysValid || !dirty || !days.success) return;
        const next: BinPolicy = { enabled, days: days.data };
        const previous = saved;
        setMessage(null);
        // Shown as saved now; put back if the server refuses.
        setSaved(next);
        startTransition(async () => {
            const result = await setBinPolicyAction(next);
            if (result.error || !result.policy) {
                setSaved(previous);
                setMessage({
                    tone: "error",
                    text:
                        result.error === "invalid"
                            ? t("bin.daysInvalid")
                            : result.error === "forbidden" && lockText
                              ? lockText
                              : t("binSettings.failed")
                });
                return;
            }
            setSaved(result.policy);
            setMessage({ tone: "ok", text: t("binSettings.saved") });
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("binSettings.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("binSettings.intro")}</p>
                </div>
                {lockText && (
                    <p id={lockId} className="text-sm text-muted-foreground">
                        {lockText}
                    </p>
                )}
                <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm">{t("binSettings.enabled")}</p>
                        {!enabled && (
                            <p id={hintId} className="text-xs text-muted-foreground">
                                {t("binSettings.offHint")}
                            </p>
                        )}
                    </div>
                    <Switch
                        checked={enabled}
                        disabled={locked || pending}
                        onChange={(next) => {
                            setEnabled(next);
                            setMessage(null);
                        }}
                        aria-label={t("binSettings.enabled")}
                        aria-describedby={lockText ? lockId : !enabled ? hintId : undefined}
                    />
                </div>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                        {t("binSettings.days")} <span aria-hidden="true">*</span>
                    </span>
                    <span className="flex items-center gap-2">
                        <Input
                            className="w-24"
                            inputMode="numeric"
                            value={daysDraft}
                            disabled={locked || pending || !enabled}
                            aria-invalid={daysDraft !== "" && !daysValid}
                            aria-describedby={lockText ? lockId : undefined}
                            onChange={(event) => {
                                setDaysDraft(event.target.value.replace(/\D/g, "").slice(0, 3));
                                setMessage(null);
                            }}
                        />
                        <span className="text-sm text-muted-foreground">{t("bin.daysUnit")}</span>
                    </span>
                    {daysDraft !== "" && !daysValid && (
                        <span className="text-xs text-danger-ink">{t("bin.daysInvalid")}</span>
                    )}
                </label>
                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        size="sm"
                        disabled={locked || pending || !daysValid || !dirty}
                        title={lockText ?? undefined}
                        onClick={save}
                    >
                        {pending && <Loader2 className="size-3.5 animate-spin" />}
                        {t("binSettings.save")}
                    </Button>
                    {message && (
                        <p
                            role="status"
                            className={
                                message.tone === "ok"
                                    ? "text-sm text-muted-foreground"
                                    : "text-sm text-danger-ink"
                            }
                        >
                            {message.text}
                        </p>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}

"use client";

/**
 * When an update that fixes a vulnerability installs itself, one answer per
 * severity: at once, at this deployment's quietest hour, every day at a time
 * picked here (as the general "every day at" above), or only tell me.
 *
 * Critical and high install at once by default. Leaving either to wait is
 * allowed, but it is accepting a known hole, so the change is not saved until
 * the administrator ticks that they accept it - in a dialog, not a native
 * confirm - and the server refuses it without that, too.
 */

import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Checkbox,
    DateInput,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Skeleton
} from "@polaris/ui";
import {
    DEFAULT_SECURITY_DAILY_AT,
    SECURITY_SEVERITIES,
    SECURITY_UPDATE_TIMINGS,
    securityPolicyLowers,
    type SecuritySeverity,
    type SecurityUpdatePolicy,
    type SecurityUpdateTiming
} from "@polaris/core";
import { saveSecurityUpdateAction, securityUpdatePolicyAction } from "./actions";

type Timings = Pick<SecurityUpdatePolicy, SecuritySeverity | "times">;

/** A complete 24-hour time. The time field reports "" until one is typed. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export function SecurityUpdates({ disabled }: { disabled?: boolean }) {
    const t = useTranslations("admin");
    const [policy, setPolicy] = useState<SecurityUpdatePolicy | null>(null);
    const [hour, setHour] = useState(4);
    const [error, setError] = useState<string | null>(null);
    const [pendingRisk, setPendingRisk] = useState<Timings | null>(null);
    const [accepted, setAccepted] = useState(false);
    const [saving, setSaving] = useState(false);
    // What is typed in each time field, which is half a time while it is typed.
    const [drafts, setDrafts] = useState<Partial<Record<SecuritySeverity, string>>>({});

    useEffect(() => {
        let live = true;
        void securityUpdatePolicyAction()
            .then((answer) => {
                if (!live) return;
                setPolicy(answer.policy);
                setHour(answer.quietHour);
            })
            .catch(() => live && setError(t("settings.security.errors.load")));
        return () => {
            live = false;
        };
    }, []);

    const at = `${String(hour).padStart(2, "0")}:00`;
    const choices = SECURITY_UPDATE_TIMINGS.map((value) => ({
        value,
        label:
            value === "quiet"
                ? t("settings.security.timing.quiet", { at })
                : t(`settings.security.timing.${value}`)
    }));

    async function save(next: Timings, acceptRisk: boolean) {
        if (!policy) return;
        const previous = policy;
        setPolicy({ ...policy, ...next });
        setError(null);
        setSaving(true);
        const result = await saveSecurityUpdateAction({ ...next, acceptRisk }).catch(() => null);
        setSaving(false);
        if (!result || result.error || !result.policy) {
            setPolicy(previous);
            setError(result?.error ?? t("settings.security.errors.save"));
            return;
        }
        setPolicy(result.policy);
    }

    function timesOf(current: SecurityUpdatePolicy): Timings {
        return {
            critical: current.critical,
            high: current.high,
            medium: current.medium,
            low: current.low,
            times: current.times
        };
    }

    function change(severity: SecuritySeverity, value: SecurityUpdateTiming) {
        if (!policy || policy[severity] === value) return;
        const next: Timings = { ...timesOf(policy), [severity]: value };
        // Switched to "every day at" with no time picked yet: the quiet hour is
        // the sensible first answer, and it is saved, so what shows is what runs.
        if (value === "daily" && !policy.times[severity]) {
            next.times = { ...policy.times, [severity]: at };
        }
        if (securityPolicyLowers(policy, next)) {
            setAccepted(false);
            setPendingRisk(next);
            return;
        }
        void save(next, false);
    }

    function changeTime(severity: SecuritySeverity, typed: string) {
        setDrafts((current) => ({ ...current, [severity]: typed }));
        // Only a complete time is a schedule; the half-typed states are not.
        if (!policy || !TIME_OF_DAY.test(typed) || policy.times[severity] === typed) return;
        void save({ ...timesOf(policy), times: { ...policy.times, [severity]: typed } }, false);
    }

    return (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div>
                <p className="text-sm">{t("settings.security.title")}</p>
                <p className="text-xs text-muted-foreground">{t("settings.security.description")}</p>
            </div>
            <div className="flex flex-col gap-2">
                {SECURITY_SEVERITIES.map((severity) => (
                    <div key={severity} className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="w-20 min-w-0 truncate text-sm">
                            {t(`settings.security.severity.${severity}`)}
                        </span>
                        {policy ? (
                            <>
                            <Select
                                aria-label={t("settings.security.ariaLabel", {
                                    severity: t(`settings.security.severity.${severity}`)
                                })}
                                value={policy[severity]}
                                onValueChange={(value) => change(severity, value as SecurityUpdateTiming)}
                                options={choices}
                                className="w-60 max-w-full shrink-0"
                                disabled={disabled || saving}
                            />
                            {policy[severity] === "daily" ? (
                                <DateInput
                                    mode="time"
                                    aria-label={t("settings.security.timeLabel", {
                                        severity: t(`settings.security.severity.${severity}`)
                                    })}
                                    className="w-32"
                                    value={
                                        drafts[severity] ??
                                        policy.times[severity] ??
                                        DEFAULT_SECURITY_DAILY_AT
                                    }
                                    disabled={disabled}
                                    onChange={(event) => changeTime(severity, event.target.value)}
                                />
                            ) : null}
                            </>
                        ) : (
                            <Skeleton className="h-8 w-60 max-w-full shrink-0" />
                        )}
                    </div>
                ))}
            </div>
            {policy?.riskAccepted ? (
                <p className="flex items-center gap-1.5 text-xs text-warning-ink">
                    <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                    {t("settings.security.riskStanding")}
                </p>
            ) : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}

            <Dialog open={pendingRisk !== null} onOpenChange={(open) => !open && setPendingRisk(null)}>
                <DialogContent>
                    <div className="flex flex-col gap-4">
                        <DialogHeader>
                            <DialogTitle>{t("settings.security.risk.title")}</DialogTitle>
                            <DialogDescription>{t("settings.security.risk.description")}</DialogDescription>
                        </DialogHeader>
                        <label className="flex items-start gap-2 text-sm">
                            <Checkbox
                                checked={accepted}
                                onChange={(event) => setAccepted(event.target.checked)}
                            />
                            <span>{t("settings.security.risk.accept")}</span>
                        </label>
                        <DialogFooter>
                            <Button variant="secondary" onClick={() => setPendingRisk(null)}>
                                {t("settings.security.risk.keep")}
                            </Button>
                            <Button
                                variant="danger"
                                disabled={!accepted}
                                onClick={() => {
                                    const next = pendingRisk;
                                    setPendingRisk(null);
                                    if (next) void save(next, true);
                                }}
                            >
                                {t("settings.security.risk.confirm")}
                            </Button>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

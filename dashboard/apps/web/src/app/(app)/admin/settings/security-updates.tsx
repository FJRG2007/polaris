"use client";

/**
 * When an update that fixes a vulnerability installs itself, one answer per
 * severity: at once, at this deployment's quietest hour, or only tell me.
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
    SECURITY_SEVERITIES,
    SECURITY_UPDATE_TIMINGS,
    securityPolicyLowers,
    type SecuritySeverity,
    type SecurityUpdatePolicy,
    type SecurityUpdateTiming
} from "@polaris/core";
import { saveSecurityUpdateAction, securityUpdatePolicyAction } from "./actions";

type Timings = Pick<SecurityUpdatePolicy, SecuritySeverity>;

export function SecurityUpdates({ disabled }: { disabled?: boolean }) {
    const t = useTranslations("admin");
    const [policy, setPolicy] = useState<SecurityUpdatePolicy | null>(null);
    const [hour, setHour] = useState(4);
    const [error, setError] = useState<string | null>(null);
    const [pendingRisk, setPendingRisk] = useState<Timings | null>(null);
    const [accepted, setAccepted] = useState(false);
    const [saving, setSaving] = useState(false);

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

    function change(severity: SecuritySeverity, value: SecurityUpdateTiming) {
        if (!policy || policy[severity] === value) return;
        const next: Timings = {
            critical: policy.critical,
            high: policy.high,
            medium: policy.medium,
            low: policy.low,
            [severity]: value
        };
        if (securityPolicyLowers(policy, next)) {
            setAccepted(false);
            setPendingRisk(next);
            return;
        }
        void save(next, false);
    }

    return (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div>
                <p className="text-sm">{t("settings.security.title")}</p>
                <p className="text-xs text-muted-foreground">{t("settings.security.description")}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SECURITY_SEVERITIES.map((severity) => (
                    <div key={severity} className="flex min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm">
                            {t(`settings.security.severity.${severity}`)}
                        </span>
                        {policy ? (
                            <Select
                                aria-label={t("settings.security.ariaLabel", {
                                    severity: t(`settings.security.severity.${severity}`)
                                })}
                                value={policy[severity]}
                                onValueChange={(value) => change(severity, value as SecurityUpdateTiming)}
                                options={choices}
                                className="w-52 shrink-0"
                                disabled={disabled || saving}
                            />
                        ) : (
                            <Skeleton className="h-8 w-52 shrink-0" />
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

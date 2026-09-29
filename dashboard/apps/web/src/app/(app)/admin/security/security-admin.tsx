"use client";

/**
 * The instance security form.
 *
 * Save stays disabled until something actually differs from what is stored, so
 * pressing it always means something. The authenticator's row is drawn but fixed:
 * it is the factor that needs nothing from the deployment, so it is what keeps the
 * requirement satisfiable when mail breaks, and it explains itself rather than
 * being silently absent from the list.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveInstanceSecurityAction } from "./actions";
import { Button, Card, CardBody, Switch } from "@polaris/ui";
import { Feedback } from "@/app/(app)/account/security/setting-card";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    SECOND_FACTOR_ENROLLMENTS,
    type InstanceSecurityPolicy,
    type SecondFactorEnrollment
} from "@polaris/core";

export function SecurityAdmin({ policy, mailReady }: { policy: InstanceSecurityPolicy; mailReady: boolean }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const [required, setRequired] = useState(policy.requireSecondFactor);
    const [accepted, setAccepted] = useState<SecondFactorEnrollment[]>(policy.acceptedFactors);
    const [connectionChallenge, setConnectionChallenge] = useState(policy.challengeConnectionSignIn);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ error?: string; ok?: string } | null>(null);

    const sameList =
        accepted.length === policy.acceptedFactors.length &&
        accepted.every((factor) => policy.acceptedFactors.includes(factor));
    const dirty =
        required !== policy.requireSecondFactor ||
        !sameList ||
        connectionChallenge !== policy.challengeConnectionSignIn;

    function toggle(factor: SecondFactorEnrollment, on: boolean) {
        setResult(null);
        setAccepted((current) =>
            on ? [...new Set([...current, factor])] : current.filter((entry) => entry !== factor)
        );
    }

    async function save() {
        setBusy(true);
        setResult(null);
        const response = await saveInstanceSecurityAction({
            requireSecondFactor: required,
            acceptedFactors: accepted,
            challengeConnectionSignIn: connectionChallenge
        });
        setBusy(false);
        setResult(response);
        if (!response.error) router.refresh();
    }

    return (
        <div className="flex max-w-2xl flex-col gap-3">
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <h2 className="text-sm font-medium">{t("security.require.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("security.require.hint")}</p>
                        </div>
                        <Switch
                            checked={required}
                            onChange={(next) => {
                                setResult(null);
                                setRequired(next);
                            }}
                            aria-label={t("security.require.title")}
                        />
                    </div>
                    {!required ? (
                        <p className="text-xs text-muted-foreground">{t("security.require.off")}</p>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">{t("security.factors.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("security.factors.hint")}</p>
                    </div>
                    {SECOND_FACTOR_ENROLLMENTS.map((factor) => {
                        const label = t(`security.factors.${factor}.label`);
                        const fixed = factor === "totp";
                        const unavailable = factor === "email" && !mailReady;
                        return (
                            <div key={factor} className="flex items-start justify-between gap-4 border-t border-border pt-3 first:border-0 first:pt-0">
                                <div className="min-w-0">
                                    <p className="text-sm">{label}</p>
                                    <p className="text-xs text-muted-foreground">{t(`security.factors.${factor}.description`)}</p>
                                    {fixed ? (
                                        <p className="mt-1 text-xs text-muted-foreground">{t("security.factors.fixed")}</p>
                                    ) : null}
                                    {unavailable ? (
                                        <p className="mt-1 text-xs text-danger">{t("security.factors.noMail")}</p>
                                    ) : null}
                                </div>
                                <Switch
                                    checked={fixed || accepted.includes(factor)}
                                    disabled={fixed}
                                    onChange={(next) => toggle(factor, next)}
                                    aria-label={label}
                                />
                            </div>
                        );
                    })}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <h2 className="text-sm font-medium">{t("security.connection.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("security.connection.hint")}</p>
                        </div>
                        <Switch
                            checked={connectionChallenge}
                            onChange={(next) => {
                                setResult(null);
                                setConnectionChallenge(next);
                            }}
                            aria-label={t("security.connection.title")}
                        />
                    </div>
                    {!connectionChallenge ? (
                        <p className="text-xs text-muted-foreground">{t("security.connection.off")}</p>
                    ) : null}
                </CardBody>
            </Card>

            <div className="flex items-center gap-3">
                <Button onClick={() => void save()} disabled={!dirty || busy}>
                    {busy ? tc("actions.saving") : tc("actions.save")}
                </Button>
                <Feedback error={result?.error} ok={result?.ok} />
            </div>
        </div>
    );
}

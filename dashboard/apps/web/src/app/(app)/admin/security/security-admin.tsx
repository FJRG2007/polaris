"use client";

/**
 * The instance security form.
 *
 * Save stays disabled until something actually differs from what is stored, so
 * pressing it always means something. Turning the second step off is the one
 * change that does not wait for Save: it is a risk, so it goes through the
 * acceptance dialog, whose confirm saves the form with the risk accepted. The authenticator's row is drawn but fixed:
 * it is the factor that needs nothing from the deployment, so it is what keeps the
 * requirement satisfiable when mail breaks, and it explains itself rather than
 * being silently absent from the list.
 */

import Link from "next/link";
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { saveInstanceSecurityAction } from "./actions";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { Feedback } from "@/app/(app)/account/security/setting-card";
import { RiskAcceptanceDialog } from "@/components/risk-acceptance-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    PHISHING_RESISTANT_SCOPES,
    SECOND_FACTOR_ENROLLMENTS,
    type PhishingResistantScope,
    type InstanceSecurityPolicy,
    type SecondFactorEnrollment
} from "@polaris/core";

/** Where the WhatsApp code sender is connected, which a phone requirement needs. */
const MESSAGING_PATH = "/admin/integrations/messaging";

export function SecurityAdmin({
    policy,
    mailReady,
    phoneReady
}: {
    policy: InstanceSecurityPolicy;
    mailReady: boolean;
    /** Whether a WhatsApp code sender is connected, so a phone can be confirmed at all. */
    phoneReady: boolean;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const [required, setRequired] = useState(policy.requireSecondFactor);
    const [accepted, setAccepted] = useState<SecondFactorEnrollment[]>(policy.acceptedFactors);
    const [connectionChallenge, setConnectionChallenge] = useState(policy.challengeConnectionSignIn);
    const [approval, setApproval] = useState(policy.requireLoginApproval);
    const [phishing, setPhishing] = useState<PhishingResistantScope>(policy.requirePhishingResistant);
    const [phone, setPhone] = useState(policy.requirePhone);
    // Turning the second step off waits on the administrator accepting the risk.
    const [askingRisk, setAskingRisk] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ error?: string; ok?: string } | null>(null);

    const sameList =
        accepted.length === policy.acceptedFactors.length &&
        accepted.every((factor) => policy.acceptedFactors.includes(factor));
    const dirty =
        required !== policy.requireSecondFactor ||
        !sameList ||
        connectionChallenge !== policy.challengeConnectionSignIn ||
        approval !== policy.requireLoginApproval ||
        phishing !== policy.requirePhishingResistant ||
        phone !== policy.requirePhone;
    // Turning the requirement on needs a sender; turning it off never does.
    const phoneBlocked = !phoneReady && !phone;

    function toggle(factor: SecondFactorEnrollment, on: boolean) {
        setResult(null);
        setAccepted((current) =>
            on ? [...new Set([...current, factor])] : current.filter((entry) => entry !== factor)
        );
    }

    /**
     * Save the whole form. `acceptRisk` is only ever true from the risk dialog,
     * which also passes the second step as off, since the state it set has not
     * landed yet when the save starts.
     */
    async function save(acceptRisk = false) {
        const requireSecondFactor = acceptRisk ? false : required;
        setBusy(true);
        setResult(null);
        const response: { error?: string; ok?: string } = await saveInstanceSecurityAction({
            requireSecondFactor,
            acceptedFactors: accepted,
            challengeConnectionSignIn: connectionChallenge,
            requireLoginApproval: approval,
            requirePhishingResistant: phishing,
            requirePhone: phone,
            acceptRisk
        }).catch(() => ({ error: t("security.errors.saveFailed") }));
        setBusy(false);
        setResult(response);
        if (response.error) {
            // Back to what is stored: a refused save turned nothing off.
            if (acceptRisk) setRequired(policy.requireSecondFactor);
            return;
        }
        router.refresh();
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
                            disabled={busy}
                            onChange={(next) => {
                                setResult(null);
                                // Off from a stored "on" is accepting a risk, which
                                // is asked for before anything changes.
                                if (!next && policy.requireSecondFactor) {
                                    setAskingRisk(true);
                                    return;
                                }
                                setRequired(next);
                            }}
                            aria-label={t("security.require.title")}
                        />
                    </div>
                    {!required ? (
                        <p className="text-xs text-muted-foreground">{t("security.require.off")}</p>
                    ) : null}
                    {!policy.requireSecondFactor ? (
                        <p className="flex items-center gap-1.5 text-xs text-warning-ink">
                            <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                            {t("security.require.riskStanding")}
                        </p>
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

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium">{t("security.approval.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("security.approval.hint")}</p>
                        </div>
                        <Switch
                            checked={approval}
                            onChange={(next) => {
                                setResult(null);
                                setApproval(next);
                            }}
                            aria-label={t("security.approval.title")}
                        />
                    </div>
                    {!approval ? (
                        <p className="text-xs text-muted-foreground">{t("security.approval.off")}</p>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium">{t("security.phone.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("security.phone.hint")}</p>
                        </div>
                        <Switch
                            checked={phone}
                            disabled={phoneBlocked}
                            onChange={(next) => {
                                setResult(null);
                                setPhone(next);
                            }}
                            aria-label={t("security.phone.title")}
                        />
                    </div>
                    {!phoneReady ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <p className="min-w-0 text-xs text-danger">{t("security.phone.noChannel")}</p>
                            <Button asChild variant="outline" size="sm" className="w-fit shrink-0">
                                <Link href={MESSAGING_PATH}>{t("security.phone.fix")}</Link>
                            </Button>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium">{t("security.phishing.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("security.phishing.hint")}</p>
                        </div>
                        <Select
                            className="sm:w-40 sm:shrink-0"
                            value={phishing}
                            onValueChange={(next) => {
                                setResult(null);
                                setPhishing(next as PhishingResistantScope);
                            }}
                            aria-label={t("security.phishing.title")}
                            options={PHISHING_RESISTANT_SCOPES.map((scope) => ({
                                value: scope,
                                label: t(`security.phishing.${scope}`)
                            }))}
                        />
                    </div>
                </CardBody>
            </Card>

            <div className="flex items-center gap-3">
                <Button onClick={() => void save()} disabled={!dirty || busy}>
                    {busy ? tc("actions.saving") : tc("actions.save")}
                </Button>
                <Feedback error={result?.error} ok={result?.ok} />
            </div>

            <RiskAcceptanceDialog
                open={askingRisk}
                copy={{
                    title: t("security.require.risk.title"),
                    description: t("security.require.risk.description"),
                    accept: t("security.require.risk.accept"),
                    keep: t("security.require.risk.keep"),
                    confirm: t("security.require.risk.confirm")
                }}
                onKeep={() => setAskingRisk(false)}
                onAccept={() => {
                    setAskingRisk(false);
                    setRequired(false);
                    void save(true);
                }}
            />
        </div>
    );
}

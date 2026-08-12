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
import {
    SECOND_FACTOR_ENROLLMENT_INFO,
    SECOND_FACTOR_ENROLLMENTS,
    type InstanceSecurityPolicy,
    type SecondFactorEnrollment
} from "@polaris/core";

export function SecurityAdmin({ policy, mailReady }: { policy: InstanceSecurityPolicy; mailReady: boolean }) {
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
                            <h2 className="text-sm font-medium">Require a second step to sign in</h2>
                            <p className="text-xs text-muted-foreground">
                                Every account adds one before it can use Polaris. Accounts that already exist
                                are asked the next time they sign in.
                            </p>
                        </div>
                        <Switch
                            checked={required}
                            onChange={(next) => {
                                setResult(null);
                                setRequired(next);
                            }}
                            aria-label="Require a second step to sign in"
                        />
                    </div>
                    {!required ? (
                        <p className="text-xs text-muted-foreground">
                            With this off, a password is all an account needs. People can still turn on a
                            second step for themselves under their own security settings.
                        </p>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">What counts as a second step</h2>
                        <p className="text-xs text-muted-foreground">
                            People pick from whichever of these works on this deployment.
                        </p>
                    </div>
                    {SECOND_FACTOR_ENROLLMENTS.map((factor) => {
                        const info = SECOND_FACTOR_ENROLLMENT_INFO[factor];
                        const fixed = factor === "totp";
                        const unavailable = factor === "email" && !mailReady;
                        return (
                            <div key={factor} className="flex items-start justify-between gap-4 border-t border-border pt-3 first:border-0 first:pt-0">
                                <div className="min-w-0">
                                    <p className="text-sm">{info.label}</p>
                                    <p className="text-xs text-muted-foreground">{info.description}</p>
                                    {fixed ? (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            Always accepted. It needs nothing from this deployment, so it is
                                            what people can still use when everything else is unreachable.
                                        </p>
                                    ) : null}
                                    {unavailable ? (
                                        <p className="mt-1 text-xs text-destructive">
                                            No email channel carries account mail yet, so nobody can pick this.
                                            Connect a sender under Inbox &gt; Channels, then nominate it under
                                            Management &gt; Email.
                                        </p>
                                    ) : null}
                                </div>
                                <Switch
                                    checked={fixed || accepted.includes(factor)}
                                    disabled={fixed}
                                    onChange={(next) => toggle(factor, next)}
                                    aria-label={info.label}
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
                            <h2 className="text-sm font-medium">Ask again after a connected account</h2>
                            <p className="text-xs text-muted-foreground">
                                Signing in with GitHub or Google answers that service first. With this on,
                                Polaris asks for the second step afterwards as well.
                            </p>
                        </div>
                        <Switch
                            checked={connectionChallenge}
                            onChange={(next) => {
                                setResult(null);
                                setConnectionChallenge(next);
                            }}
                            aria-label="Ask again after a connected account"
                        />
                    </div>
                    {!connectionChallenge ? (
                        <p className="text-xs text-muted-foreground">
                            With this off, the service that signed them in is the whole sign-in. Anyone who
                            wants the extra step can still turn it on for their own account.
                        </p>
                    ) : null}
                </CardBody>
            </Card>

            <div className="flex items-center gap-3">
                <Button onClick={() => void save()} disabled={!dirty || busy}>
                    {busy ? "Saving..." : "Save"}
                </Button>
                <Feedback error={result?.error} ok={result?.ok} />
            </div>
        </div>
    );
}

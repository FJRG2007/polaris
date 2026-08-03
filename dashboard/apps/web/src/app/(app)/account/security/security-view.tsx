"use client";

/**
 * The Security page's composition: one card per control, each opening its own
 * dialog. Only the two session limits are edited inline - they are a pair of
 * dropdowns, and burying them in a dialog would cost a click for nothing.
 *
 * Nothing here decides anything; the server actions re-verify every change.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PasskeysCard } from "./passkeys-card";
import { ShieldAlert, Trash2 } from "lucide-react";
import type { PasskeyView } from "@/lib/passkey-directory";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import { RemovePinDialog, SetPinDialog } from "./pin-dialogs";
import { TwoFactorMethodsCard } from "./two-factor-methods-card";
import type { TwoFactorMethodStatus } from "@/lib/two-factor-delivery";
import { Feedback, SettingCard, type SettingLock } from "./setting-card";
import { setNewDeviceGraceAction, updateSessionLimitsAction } from "./actions";
import { ChangePasswordDialog, RecoverPasswordDialog } from "./password-dialogs";
import { ClearQuestionsDialog, SecurityQuestionsDialog } from "./questions-dialog";
import { DisableTwoFactorDialog, EnableTwoFactorDialog } from "./two-factor-dialogs";
import {
    IDLE_LOCK_CHOICES,
    NEW_DEVICE_GRACE_CHOICES,
    SECURITY_QUESTION_COUNT,
    SESSION_MAX_CHOICES,
    type TwoFactorMethod
} from "@polaris/core";

/** Human label for a minute count used by both limit dropdowns. */
function describeMinutes(minutes: number, zeroLabel: string): string {
    if (minutes === 0) return zeroLabel;
    if (minutes < 60) return `${minutes} minutes`;
    if (minutes < 1440) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
}

/** Human label for a wait measured in days. */
function describeDays(days: number): string {
    if (days === 0) return "No wait";
    if (days === 1) return "1 day";
    if (days === 7) return "1 week";
    if (days === 14) return "2 weeks";
    return `${days} days`;
}

export function SecurityView({
    lock,
    newDeviceGraceDays,
    hasPin,
    idleLockMinutes,
    sessionMaxMinutes,
    requireLoginApproval,
    twoFactorEnabled,
    questions,
    passkeys,
    twoFactorMethods,
    twoFactorPreferred,
    trustedDevices,
    otherSessions
}: {
    /** Set while this browser is too new on the account to change any of this.
     *  Every control below reads it; the server refuses them regardless. */
    lock?: SettingLock;
    /** Days the account makes a device newly seen on it wait. 0 is no wait. */
    newDeviceGraceDays: number;
    hasPin: boolean;
    idleLockMinutes: number;
    sessionMaxMinutes: number;
    requireLoginApproval: boolean;
    twoFactorEnabled: boolean;
    questions: string[];
    passkeys: PasskeyView[];
    twoFactorMethods: TwoFactorMethodStatus[];
    twoFactorPreferred: TwoFactorMethod;
    /** Browsers allowed to sign in without answering the challenge. */
    trustedDevices: number;
    /** Open sessions other than this one, which is what a sign-in is approved from. */
    otherSessions: number;
}) {
    const router = useRouter();
    const [dialog, setDialog] = useState<string | null>(null);
    const close = () => setDialog(null);

    const [limits, setLimits] = useState({ idleLockMinutes, sessionMaxMinutes });
    const [limitsBusy, setLimitsBusy] = useState(false);
    const [limitsResult, setLimitsResult] = useState<{ error?: string; ok?: string } | null>(null);
    const limitsChanged =
        limits.idleLockMinutes !== idleLockMinutes || limits.sessionMaxMinutes !== sessionMaxMinutes;

    async function saveLimits() {
        setLimitsBusy(true);
        setLimitsResult(null);
        const result = await updateSessionLimitsAction(limits);
        setLimitsBusy(false);
        setLimitsResult(result.error ? result : { ok: "Saved." });
        if (!result.error) router.refresh();
    }

    const [grace, setGrace] = useState(newDeviceGraceDays);
    const [graceBusy, setGraceBusy] = useState(false);
    const [graceResult, setGraceResult] = useState<{ error?: string; ok?: string } | null>(null);

    async function saveGrace(days: number) {
        setGrace(days);
        setGraceBusy(true);
        setGraceResult(null);
        const result = await setNewDeviceGraceAction(days);
        setGraceBusy(false);
        setGraceResult(result.error ? result : { ok: "Saved." });
        if (result.error) setGrace(newDeviceGraceDays);
        else router.refresh();
    }

    const hasQuestions = questions.length === SECURITY_QUESTION_COUNT;
    const locked = Boolean(lock);

    return (
        <div className="flex flex-col gap-4">
            {lock ? (
                <Card>
                    <CardBody className="flex items-start gap-3">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                        <div>
                            <h2 className="text-sm font-medium">This device is still new here</h2>
                            <p className="text-xs text-muted-foreground">{lock.reason}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Use a device you have signed in from before, or wait it out. Signing
                                out from here still works.
                            </p>
                        </div>
                    </CardBody>
                </Card>
            ) : null}

            <SettingCard
                title="Password"
                description="Changing it signs out every other session."
            >
                <Button variant="ghost" disabled={locked} onClick={() => setDialog("recover")}>
                    I forgot it
                </Button>
                <Button disabled={locked} onClick={() => setDialog("password")}>
                    Change
                </Button>
            </SettingCard>

            <SettingCard
                title="Authenticator app"
                description="A time-based code from your phone, asked for after your password."
                status={twoFactorEnabled ? "On" : "Off"}
                statusTone={twoFactorEnabled ? "on" : "off"}
            >
                {twoFactorEnabled ? (
                    <Button variant="outline" disabled={locked} onClick={() => setDialog("2fa-off")}>
                        Turn off
                    </Button>
                ) : (
                    <Button disabled={locked} onClick={() => setDialog("2fa-on")}>
                        Set up
                    </Button>
                )}
            </SettingCard>

            <TwoFactorMethodsCard
                lock={lock}
                statuses={twoFactorMethods}
                preferred={twoFactorPreferred}
                twoFactorEnabled={twoFactorEnabled}
                trustedDevices={trustedDevices}
                approval={{ enabled: requireLoginApproval, hasPin, otherSessions }}
            />

            <PasskeysCard passkeys={passkeys} lock={lock} />

            <SettingCard
                title="Quick unlock PIN"
                // Not conditional on the approval gate any more: the PIN also
                // confirms a sign-in allowed by scanning the code on the sign-in
                // screen, which every account can do whether or not that gate is on.
                description="Reopens a locked dashboard, and confirms a sign-in you allow from here."
                status={hasPin ? "Set" : "Not set"}
                statusTone={hasPin ? "on" : "off"}
            >
                {hasPin ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove quick unlock PIN"
                        disabled={locked}
                        onClick={() => setDialog("pin-off")}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                ) : null}
                <Button disabled={locked} onClick={() => setDialog("pin")}>
                    {hasPin ? "Change" : "Set PIN"}
                </Button>
            </SettingCard>

            <SettingCard
                title="Security questions"
                description="Used to set a new password when you have forgotten the current one."
                status={hasQuestions ? "Set" : "Not set"}
                statusTone={hasQuestions ? "on" : "off"}
            >
                {hasQuestions ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove security questions"
                        disabled={locked}
                        onClick={() => setDialog("questions-off")}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                ) : null}
                <Button disabled={locked} onClick={() => setDialog("questions")}>
                    {hasQuestions ? "Update" : "Set up"}
                </Button>
            </SettingCard>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">New devices</h2>
                        <p className="text-xs text-muted-foreground">
                            Make a browser you have not signed in from before wait before it can
                            change anything on this page. It buys you time to notice if someone
                            else signs in with your password.
                        </p>
                    </div>
                    <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
                        Wait before a new device can change security
                        <Select
                            value={String(grace)}
                            disabled={locked || graceBusy}
                            onValueChange={(value) => void saveGrace(Number(value))}
                            options={NEW_DEVICE_GRACE_CHOICES.map((days) => ({
                                value: String(days),
                                label: describeDays(days)
                            }))}
                        />
                    </label>
                    <p className="text-xs text-muted-foreground">
                        A waiting device can still read this page and sign itself out. Devices you
                        already use are not affected.
                    </p>
                    <Feedback error={graceResult?.error} ok={graceResult?.ok} />
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">Session limits</h2>
                        <p className="text-xs text-muted-foreground">
                            When to lock the dashboard, and when to end the session outright.
                        </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            Lock after inactivity
                            <Select
                                value={String(limits.idleLockMinutes)}
                                disabled={locked}
                                onValueChange={(value) =>
                                    setLimits((prev) => ({ ...prev, idleLockMinutes: Number(value) }))
                                }
                                options={IDLE_LOCK_CHOICES.map((minutes) => ({
                                    value: String(minutes),
                                    label: describeMinutes(minutes, "Never")
                                }))}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Sign out after
                            <Select
                                value={String(limits.sessionMaxMinutes)}
                                disabled={locked}
                                onValueChange={(value) =>
                                    setLimits((prev) => ({ ...prev, sessionMaxMinutes: Number(value) }))
                                }
                                options={SESSION_MAX_CHOICES.map((minutes) => ({
                                    value: String(minutes),
                                    label: describeMinutes(minutes, "Instance default (7 days)")
                                }))}
                            />
                        </label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Unlocking asks for your PIN, or your password when no PIN is set.
                    </p>
                    <div className="flex items-center justify-between gap-2">
                        <Feedback error={limitsResult?.error} ok={limitsResult?.ok} />
                        <Button
                            onClick={() => void saveLimits()}
                            disabled={locked || limitsBusy || !limitsChanged}
                            className="ml-auto"
                        >
                            {limitsBusy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <ChangePasswordDialog open={dialog === "password"} onOpenChange={(open) => !open && close()} />
            <RecoverPasswordDialog
                open={dialog === "recover"}
                onOpenChange={(open) => !open && close()}
                questions={questions}
                canUseAuthenticator={twoFactorEnabled}
            />
            <EnableTwoFactorDialog
                open={dialog === "2fa-on"}
                onOpenChange={(open) => !open && close()}
                onDone={() => router.refresh()}
            />
            <DisableTwoFactorDialog
                open={dialog === "2fa-off"}
                onOpenChange={(open) => !open && close()}
                onDone={() => router.refresh()}
            />
            <SetPinDialog open={dialog === "pin"} onOpenChange={(open) => !open && close()} hasPin={hasPin} />
            <RemovePinDialog open={dialog === "pin-off"} onOpenChange={(open) => !open && close()} />
            <SecurityQuestionsDialog
                open={dialog === "questions"}
                onOpenChange={(open) => !open && close()}
                existing={questions}
            />
            <ClearQuestionsDialog open={dialog === "questions-off"} onOpenChange={(open) => !open && close()} />
        </div>
    );
}

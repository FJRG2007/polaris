"use client";

/**
 * The Security page's composition: one card per control, each opening its own
 * dialog. Only the two session limits are edited inline - they are a pair of
 * dropdowns, and burying them in a dialog would cost a click for nothing.
 *
 * Nothing here decides anything; the server actions re-verify every change.
 */

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { PasskeysCard } from "./passkeys-card";
import type { PasskeyView } from "./passkey-actions";
import { updateSessionLimitsAction } from "./actions";
import { Feedback, SettingCard } from "./setting-card";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import { RemovePinDialog, SetPinDialog } from "./pin-dialogs";
import { TwoFactorMethodsCard } from "./two-factor-methods-card";
import type { TwoFactorMethodStatus } from "@/lib/two-factor-delivery";
import { ChangePasswordDialog, RecoverPasswordDialog } from "./password-dialogs";
import { ClearQuestionsDialog, SecurityQuestionsDialog } from "./questions-dialog";
import { DisableTwoFactorDialog, EnableTwoFactorDialog } from "./two-factor-dialogs";
import {
    IDLE_LOCK_CHOICES,
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

export function SecurityView({
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

    const hasQuestions = questions.length === SECURITY_QUESTION_COUNT;

    return (
        <div className="flex flex-col gap-4">
            <SettingCard
                title="Password"
                description="Changing it signs out every other session."
            >
                <Button variant="ghost" onClick={() => setDialog("recover")}>
                    I forgot it
                </Button>
                <Button onClick={() => setDialog("password")}>Change</Button>
            </SettingCard>

            <SettingCard
                title="Authenticator app"
                description="A time-based code from your phone, asked for after your password."
                status={twoFactorEnabled ? "On" : "Off"}
                statusTone={twoFactorEnabled ? "on" : "off"}
            >
                {twoFactorEnabled ? (
                    <Button variant="outline" onClick={() => setDialog("2fa-off")}>
                        Turn off
                    </Button>
                ) : (
                    <Button onClick={() => setDialog("2fa-on")}>Set up</Button>
                )}
            </SettingCard>

            <TwoFactorMethodsCard
                statuses={twoFactorMethods}
                preferred={twoFactorPreferred}
                twoFactorEnabled={twoFactorEnabled}
                trustedDevices={trustedDevices}
                approval={{ enabled: requireLoginApproval, hasPin, otherSessions }}
            />

            <PasskeysCard passkeys={passkeys} />

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
                        onClick={() => setDialog("pin-off")}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                ) : null}
                <Button onClick={() => setDialog("pin")}>{hasPin ? "Change" : "Set PIN"}</Button>
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
                        onClick={() => setDialog("questions-off")}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                ) : null}
                <Button onClick={() => setDialog("questions")}>{hasQuestions ? "Update" : "Set up"}</Button>
            </SettingCard>

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
                            disabled={limitsBusy || !limitsChanged}
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

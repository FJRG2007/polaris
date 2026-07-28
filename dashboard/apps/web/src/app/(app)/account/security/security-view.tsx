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
import { IDLE_LOCK_CHOICES, SECURITY_QUESTION_COUNT, SESSION_MAX_CHOICES } from "@polaris/core";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { setLoginApprovalAction, updateSessionLimitsAction } from "./actions";
import { ChangePasswordDialog, RecoverPasswordDialog } from "./password-dialogs";
import { DisableTwoFactorDialog, EnableTwoFactorDialog } from "./two-factor-dialogs";
import { RemovePinDialog, SetPinDialog } from "./pin-dialogs";
import { ClearQuestionsDialog, SecurityQuestionsDialog } from "./questions-dialog";
import { Feedback, SettingCard } from "./setting-card";

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
    questions
}: {
    hasPin: boolean;
    idleLockMinutes: number;
    sessionMaxMinutes: number;
    requireLoginApproval: boolean;
    twoFactorEnabled: boolean;
    questions: string[];
}) {
    const router = useRouter();
    const [dialog, setDialog] = useState<string | null>(null);
    const close = () => setDialog(null);

    const [limits, setLimits] = useState({ idleLockMinutes, sessionMaxMinutes });
    const [limitsBusy, setLimitsBusy] = useState(false);
    const [limitsResult, setLimitsResult] = useState<{ error?: string; ok?: string } | null>(null);
    const [approval, setApproval] = useState(requireLoginApproval);

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

    async function toggleApproval(next: boolean) {
        setApproval(next);
        await setLoginApprovalAction(next);
        router.refresh();
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

            <SettingCard
                title="Quick unlock PIN"
                description="Reopens a locked dashboard without retyping your password."
                status={hasPin ? "Set" : "Not set"}
                statusTone={hasPin ? "on" : "off"}
            >
                {hasPin ? (
                    <Button variant="outline" onClick={() => setDialog("pin-off")}>
                        Remove
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
                    <Button variant="outline" onClick={() => setDialog("questions-off")}>
                        Remove
                    </Button>
                ) : null}
                <Button onClick={() => setDialog("questions")}>{hasQuestions ? "Update" : "Set up"}</Button>
            </SettingCard>

            <SettingCard
                title="Approve new sign-ins"
                description="A new sign-in waits until you allow it from a session that is already open."
                status={approval ? "On" : "Off"}
                statusTone={approval ? "on" : "off"}
            >
                <Switch
                    checked={approval}
                    onChange={(next) => void toggleApproval(next)}
                    aria-label="Require approval for new sign-ins"
                />
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

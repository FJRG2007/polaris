"use client";

/**
 * The Security page's composition: one card per control, each opening its own
 * dialog. Only the two session limits are edited inline - they are a pair of
 * dropdowns, and burying them in a dialog would cost a click for nothing.
 *
 * The cards sit in two columns once the viewport can carry them, split by what
 * they answer: the left column is how a sign-in is proved, the right is the ways
 * back in when that fails and what a session is allowed afterwards. Passkeys run
 * the full width underneath, because that card is a table with a row per device
 * and columns that had nowhere to go inside a half-width card.
 *
 * Nothing here decides anything; the server actions re-verify every change.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PasskeysCard } from "./passkeys-card";
import { EmailLinkCard } from "./email-link-card";
import { UsernameSignInCard } from "./username-sign-in-card";
import { ShieldAlert, Trash2 } from "lucide-react";
import { BackupCodesCard } from "./backup-codes-card";
import type { PasskeyView } from "@/lib/passkey-directory";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import { RemovePinDialog, SetPinDialog } from "./pin-dialogs";
import { TwoFactorMethodsCard } from "./two-factor-methods-card";
import { SuccessorCard, type SuccessorPerson } from "./successor-card";
import type { TwoFactorMethodStatus } from "@/lib/two-factor-delivery";
import { Feedback, SettingCard, type SettingLock } from "./setting-card";
import { LockdownCard } from "./lockdown-card";
import { SessionBindingCard } from "./session-binding-card";
import type { AccountStanding } from "@/lib/account-lifecycle";
import { setNewDeviceGraceAction, updateSessionLimitsAction } from "./actions";
import { ChangePasswordDialog, RecoverPasswordDialog } from "./password-dialogs";
import { ClearQuestionsDialog, SecurityQuestionsDialog } from "./questions-dialog";
import { DisableTwoFactorDialog, EnableTwoFactorDialog } from "./two-factor-dialogs";
import { ConnectedSignInCard, type ConnectedSignIn, type ConnectionChallenge } from "./connected-sign-in-card";
import {
    IDLE_LOCK_CHOICES,
    type AddressPinScope,
    NEW_DEVICE_GRACE_CHOICES,
    SECURITY_QUESTION_COUNT,
    SESSION_MAX_CHOICES,
    type TwoFactorMethod
} from "@polaris/core";

type Translate = NamespaceTranslator<"accountSecurity">;

/** Human label for a minute count used by both limit dropdowns. */
function describeMinutes(t: Translate, minutes: number, zeroLabel: string): string {
    if (minutes === 0) return zeroLabel;
    if (minutes < 60) return t("duration.minutes", { count: minutes });
    if (minutes < 1440) return t("duration.hours", { count: minutes / 60 });
    return t("duration.days", { count: minutes / 1440 });
}

/** Human label for a wait measured in days. */
function describeDays(t: Translate, days: number): string {
    if (days === 0) return t("duration.noWait");
    if (days === 7) return t("duration.oneWeek");
    if (days === 14) return t("duration.twoWeeks");
    return t("duration.days", { count: days });
}

export function SecurityView({
    lock,
    account,
    newDeviceGraceDays,
    hasPin,
    idleLockMinutes,
    bindSessionsToClient,
    pinSessionsToAddress,
    standing,
    sessionMaxMinutes,
    requireLoginApproval,
    emailLinkSignIn,
    usernameSignIn,
    username,
    canSendMail,
    twoFactorEnabled,
    backupCodesRemaining,
    questions,
    passkeys,
    twoFactorMethods,
    twoFactorPreferred,
    trustedDevices,
    connections,
    connectionChallenge,
    otherSessions,
    successor
}: {
    /** Set while this browser is too new on the account to change any of this.
     *  Every control below reads it; the server refuses them regardless. */
    lock?: SettingLock;
    /** Who these codes belong to, so a downloaded or printed set says which
     *  account it opens. */
    account: string;
    /** Days the account makes a device newly seen on it wait. 0 is no wait. */
    newDeviceGraceDays: number;
    hasPin: boolean;
    idleLockMinutes: number;
    /** What a session is tied to beyond the cookie: the browser it was opened
     *  in, and which devices are also tied to their address. */
    bindSessionsToClient: boolean;
    pinSessionsToAddress: AddressPinScope;
    /** Whether the account is shut down, switched off, or on its way out. */
    standing: AccountStanding;
    sessionMaxMinutes: number;
    requireLoginApproval: boolean;
    /** Whether a link emailed to this account signs it in. Off unless asked for. */
    emailLinkSignIn: boolean;
    /** Whether the username may stand in for the address at sign-in. */
    usernameSignIn: boolean;
    /** The handle itself, so the card can name it. */
    username: string;
    /** Whether this Polaris has a way to send mail at all, which is what decides
     *  whether the switch above it can do anything. */
    canSendMail: boolean;
    twoFactorEnabled: boolean;
    /** Backup codes still unspent, or null when there is no readable set. */
    backupCodesRemaining: number | null;
    questions: string[];
    passkeys: PasskeyView[];
    twoFactorMethods: TwoFactorMethodStatus[];
    twoFactorPreferred: TwoFactorMethod;
    /** Browsers allowed to sign in without answering the challenge. */
    trustedDevices: number;
    /** The outside accounts this person has connected, each with whether it may
     *  sign them in. */
    connections: ConnectedSignIn[];
    /** Whether one of those sign-ins still owes the second step, and whether the
     *  instance has already settled that for everybody. */
    connectionChallenge: ConnectionChallenge;
    /** Open sessions other than this one, which is what a sign-in is approved from. */
    otherSessions: number;
    /** The account named to close this one's organizations if its owner dies. */
    successor: SuccessorPerson | null;
}) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
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
        setLimitsResult(result.error ? result : { ok: t("feedback.saved") });
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
        setGraceResult(result.error ? result : { ok: t("feedback.saved") });
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
                            <h2 className="text-sm font-medium">{t("view.newDevice.title")}</h2>
                            <p className="text-xs text-muted-foreground">{lock.reason}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{t("view.newDevice.hint")}</p>
                        </div>
                    </CardBody>
                </Card>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
                <div className="flex flex-col gap-4">
                    <SettingCard
                        title={t("view.password.title")}
                        description={t("view.password.description")}
                    >
                        <Button variant="ghost" disabled={locked} onClick={() => setDialog("recover")}>
                            {t("view.password.forgot")}
                        </Button>
                        <Button disabled={locked} onClick={() => setDialog("password")}>
                            {t("view.change")}
                        </Button>
                    </SettingCard>

                    <SettingCard
                        title={t("view.authenticator.title")}
                        description={t("view.authenticator.description")}
                        status={twoFactorEnabled ? t("status.on") : t("status.off")}
                        statusTone={twoFactorEnabled ? "on" : "off"}
                    >
                        {twoFactorEnabled ? (
                            <Button variant="outline" disabled={locked} onClick={() => setDialog("2fa-off")}>
                                {t("view.turnOff")}
                            </Button>
                        ) : (
                            <Button disabled={locked} onClick={() => setDialog("2fa-on")}>
                                {t("view.setUp")}
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

                    {/* Ways in, next to the ones they stand beside: a link to the
                        address, and the outside accounts that were connected. */}
                    <UsernameSignInCard
                        enabled={usernameSignIn}
                        username={username}
                        lock={lock}
                    />
                    <EmailLinkCard enabled={emailLinkSignIn} canSend={canSendMail} lock={lock} />

                    <ConnectedSignInCard
                        accounts={connections}
                        challenge={connectionChallenge}
                        twoFactorEnabled={twoFactorEnabled}
                        lock={lock}
                    />
                </div>

                <div className="flex flex-col gap-4">
                    <BackupCodesCard
                        lock={lock}
                        account={account}
                        twoFactorEnabled={twoFactorEnabled}
                        remaining={backupCodesRemaining}
                    />

                    <SettingCard
                        title={t("view.pin.title")}
                        // Not conditional on the approval gate any more: the PIN also
                        // confirms a sign-in allowed by scanning the code on the sign-in
                        // screen, which every account can do whether or not that gate is on.
                        description={t("view.pin.description")}
                        status={hasPin ? t("status.set") : t("status.notSet")}
                        statusTone={hasPin ? "on" : "off"}
                    >
                        {hasPin ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("view.pin.remove")}
                                disabled={locked}
                                onClick={() => setDialog("pin-off")}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        ) : null}
                        <Button disabled={locked} onClick={() => setDialog("pin")}>
                            {hasPin ? t("view.change") : t("view.pin.set")}
                        </Button>
                    </SettingCard>

                    <SettingCard
                        title={t("view.questions.title")}
                        description={t("view.questions.description")}
                        status={hasQuestions ? t("status.set") : t("status.notSet")}
                        statusTone={hasQuestions ? "on" : "off"}
                    >
                        {hasQuestions ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("view.questions.remove")}
                                disabled={locked}
                                onClick={() => setDialog("questions-off")}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        ) : null}
                        <Button disabled={locked} onClick={() => setDialog("questions")}>
                            {hasQuestions ? t("view.update") : t("view.setUp")}
                        </Button>
                    </SettingCard>

                    <Card>
                        <CardBody className="flex flex-col gap-3">
                            <div>
                                <h2 className="text-sm font-medium">{t("view.grace.title")}</h2>
                                <p className="text-xs text-muted-foreground">{t("view.grace.description")}</p>
                            </div>
                            <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
                                {t("view.grace.label")}
                                <Select
                                    value={String(grace)}
                                    disabled={locked || graceBusy}
                                    onValueChange={(value) => void saveGrace(Number(value))}
                                    options={NEW_DEVICE_GRACE_CHOICES.map((days) => ({
                                        value: String(days),
                                        label: describeDays(t, days)
                                    }))}
                                />
                            </label>
                            <p className="text-xs text-muted-foreground">{t("view.grace.hint")}</p>
                            <Feedback error={graceResult?.error} ok={graceResult?.ok} />
                        </CardBody>
                    </Card>

                    <Card>
                        <CardBody className="flex flex-col gap-3">
                            <div>
                                <h2 className="text-sm font-medium">{t("view.limits.title")}</h2>
                                <p className="text-xs text-muted-foreground">{t("view.limits.description")}</p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("view.limits.idleLock")}
                                    <Select
                                        value={String(limits.idleLockMinutes)}
                                        disabled={locked}
                                        onValueChange={(value) =>
                                            setLimits((prev) => ({ ...prev, idleLockMinutes: Number(value) }))
                                        }
                                        options={IDLE_LOCK_CHOICES.map((minutes) => ({
                                            value: String(minutes),
                                            label: describeMinutes(t, minutes, t("view.limits.never"))
                                        }))}
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("view.limits.signOutAfter")}
                                    <Select
                                        value={String(limits.sessionMaxMinutes)}
                                        disabled={locked}
                                        onValueChange={(value) =>
                                            setLimits((prev) => ({ ...prev, sessionMaxMinutes: Number(value) }))
                                        }
                                        options={SESSION_MAX_CHOICES.map((minutes) => ({
                                            value: String(minutes),
                                            label: describeMinutes(t, minutes, t("view.limits.defaultMax"))
                                        }))}
                                    />
                                </label>
                            </div>
                            <p className="text-xs text-muted-foreground">{t("view.limits.hint")}</p>
                            <div className="flex items-center justify-between gap-2">
                                <Feedback error={limitsResult?.error} ok={limitsResult?.ok} />
                                <Button
                                    onClick={() => void saveLimits()}
                                    disabled={locked || limitsBusy || !limitsChanged}
                                    className="ml-auto"
                                >
                                    {limitsBusy ? tc("actions.saving") : tc("actions.save")}
                                </Button>
                            </div>
                        </CardBody>
                    </Card>
                    {/* In the column rather than across the page under it. Two
                        settings and a Save do not fill the width of this screen, and
                        a card that does not fill it leaves the empty half sitting
                        beside the one thing on the page about the hours AFTER
                        signing in. */}
                    <SessionBindingCard
                        bindSessionsToClient={bindSessionsToClient}
                        pinSessionsToAddress={pinSessionsToAddress}
                        lock={lock}
                    />
                </div>
            </div>

            <PasskeysCard passkeys={passkeys} lock={lock} />
            <SuccessorCard successor={successor} lock={lock} />
            {/* Last, because it is the end of the page: the emergency switch and
                the two ways out, with nothing under them. */}
            <LockdownCard standing={standing} lock={lock} />

            <ChangePasswordDialog open={dialog === "password"} onOpenChange={(open) => !open && close()} />
            <RecoverPasswordDialog
                open={dialog === "recover"}
                onOpenChange={(open) => !open && close()}
                questions={questions}
                canUseAuthenticator={twoFactorEnabled}
            />
            <EnableTwoFactorDialog
                open={dialog === "2fa-on"}
                account={account}
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

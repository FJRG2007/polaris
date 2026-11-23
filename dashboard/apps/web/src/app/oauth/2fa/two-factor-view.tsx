"use client";

/**
 * The challenge itself. Every method ends in a six-digit code, so the form is one
 * field either way; what changes is where the code comes from and which endpoint
 * checks it - the authenticator's own, or the one better-auth stores a sent code
 * against.
 *
 * Backup codes share the screen because the moment a user needs one is the moment
 * they cannot reach their authenticator, and sending them elsewhere to find it
 * would be exactly the wrong time.
 */

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { abandonChallengeAction } from "./actions";
import { dropHeldPassword, settleAfterSecondFactor } from "@/lib/chat/e2ee/held-password";
import { landAfterSignIn } from "../login/post-login-target";
import { KeyRound, Mail, MessageSquare, Smartphone } from "lucide-react";
import { WhatsAppLogo } from "./whatsapp-logo";
import { TelegramLogo } from "./telegram-logo";
import type { ChallengeOptions } from "@/lib/two-factor-delivery";
import { PhoneApproval } from "./phone-approval";
import { useCallback, useState, type ComponentType, type FormEvent } from "react";
import { useCodeSending } from "@/components/use-code-sending";
import { TWO_FACTOR_RESEND_SECONDS } from "@/lib/two-factor-resend";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    Input,
    PolarisMark
} from "@polaris/ui";
import { TWO_FACTOR_METHOD_HEADER, type TwoFactorMethod } from "@polaris/core";
import { safeRedirect } from "@/lib/safe-redirect";
import { CodeInput, isWholeCode } from "@/components/code-input";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Post-verification destination: a safe same-origin redirect, else the drive. */
function target(): string {
    return safeRedirect(new URLSearchParams(window.location.search).get("redirect"));
}

const METHOD_ICON: Record<TwoFactorMethod, ComponentType<{ className?: string }>> = {
    totp: Smartphone,
    email: Mail,
    whatsapp: WhatsAppLogo,
    sms: MessageSquare,
    telegram: TelegramLogo
};

export function TwoFactorView({
    options,
    phoneApproval,
    steps = 1
}: {
    options: ChallengeOptions;
    phoneApproval: boolean;
    /** How many steps this sign-in is expected to take, the account's policy
     *  applied. Only shown when there is more than one. */
    steps?: number;
}) {
    const router = useRouter();
    const t = useTranslations("auth");
    const [method, setMethod] = useState<TwoFactorMethod>(options.preferred ?? "totp");
    const [backup, setBackup] = useState(false);
    const [code, setCode] = useState("");
    const [trustDevice, setTrustDevice] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Only the sent-code methods need a round trip before the field is useful;
     *  an authenticator or a backup code never sends anything. */
    const needsSending = !backup && method !== "totp";
    const entry = options.methods.find((option) => option.method === method);

    // Sent by itself on entering a method that delivers, once; the button is the
    // resend, quiet for the wait (components/use-code-sending.ts).
    const sending = useCodeSending({
        scope: needsSending ? `sign-in:${method}` : null,
        auto: true,
        send: async () => {
            const { error: sendError } = await authClient.twoFactor.sendOtp({
                fetchOptions: { headers: { [TWO_FACTOR_METHOD_HEADER]: method } }
            });
            if (!sendError) return {};
            if (sendError.status === 429) {
                const wait = Number((sendError as { retryAfterSeconds?: unknown }).retryAfterSeconds);
                return { retryAfterSeconds: Number.isFinite(wait) && wait > 0 ? wait : TWO_FACTOR_RESEND_SECONDS };
            }
            return { error: t("twoFactor.sendFailed") };
        }
    });
    const sent = sending.sent
        ? entry?.target
            ? t("twoFactor.sentTo", { target: entry.target })
            : t("twoFactor.sent")
        : null;
    const shownError = error ?? sending.error;

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const { error: verifyError } = backup
            ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
            : method === "totp"
              ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
              : await authClient.twoFactor.verifyOtp({ code, trustDevice });
        setPending(false);
        if (verifyError) {
            setError(backup ? t("twoFactor.backupInvalid") : t("twoFactor.codeInvalid"));
            return;
        }
        setPending(true);
        await settleAfterSecondFactor();
        landAfterSignIn(router, target());
    }

    /** The phone approved: spend the code it handed over, exactly as a typed one. */
    const approvedOnPhone = useCallback(
        async (approved: string) => {
            const { error: verifyError } = await authClient.twoFactor.verifyOtp({ code: approved, trustDevice });
            if (verifyError) return false;
            await settleAfterSecondFactor();
            landAfterSignIn(router, target());
            return true;
        },
        [router, trustDevice]
    );

    function choose(next: TwoFactorMethod) {
        setMethod(next);
        setBackup(false);
        setCode("");
        setError(null);
    }

    return (
        <main className="grid min-h-dvh grid-cols-[minmax(0,1fr)] place-items-center safe-p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("twoFactor.title")}</CardTitle>
                    {steps > 1 ? (
                        <p className="text-xs text-muted-foreground">{t("stepUp.progress", { current: 1, total: steps })}</p>
                    ) : null}
                </CardHeader>
                <CardBody>
                    {phoneApproval && !backup ? (
                        <PhoneApproval disabled={pending} onApproved={approvedOnPhone} />
                    ) : null}
                    {options.methods.length > 1 && !backup ? (
                        <div className="mb-4 flex flex-col gap-1">
                            {options.methods.map((option) => {
                                const Icon = METHOD_ICON[option.method];
                                const active = option.method === method;
                                return (
                                    <button
                                        key={option.method}
                                        type="button"
                                        onClick={() => choose(option.method)}
                                        aria-pressed={active}
                                        className={`flex items-center gap-3 rounded-md border px-3 py-2 text-start text-sm transition ${
                                            active
                                                ? "border-primary bg-primary/5"
                                                : "border-border hover:bg-muted/40"
                                        }`}
                                    >
                                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0">
                                            <span className="block">
                                                {t(`twoFactor.methods.${option.method}.label`)}
                                            </span>
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {option.target ??
                                                    t(
                                                        `twoFactor.methods.${option.method}.description`
                                                    )}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}

                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        {needsSending ? (
                            <Button
                                type="button"
                                variant="outline"
                                disabled={pending || sending.sending || sending.cooldown > 0}
                                onClick={sending.resend}
                            >
                                {sending.sending
                                    ? t("twoFactor.sending")
                                    : sending.cooldown > 0
                                      ? t("twoFactor.sendAgainIn", { seconds: sending.cooldown })
                                      : sent
                                        ? t("twoFactor.sendAgain")
                                        : t("twoFactor.sendCode")}
                            </Button>
                        ) : null}
                        {sent ? <p className="text-sm text-success">{sent}</p> : null}
                        <label className="flex flex-col gap-1 text-sm">
                            {backup
                                ? t("twoFactor.backupCode")
                                : method === "totp"
                                  ? t("twoFactor.authenticatorCode")
                                  : t("twoFactor.sentCode")}
                            {backup ? (
                                <Input
                                    name="code"
                                    autoFocus
                                    autoComplete="one-time-code"
                                    // i18n-ignore - the shape of a backup code, not words
                                    placeholder="XXXXXXXX"
                                    value={code}
                                    onChange={(event) => setCode(event.target.value)}
                                    required
                                />
                            ) : (
                                <CodeInput
                                    name="code"
                                    autoFocus
                                    autoSubmit
                                    value={code}
                                    onValueChange={setCode}
                                    required
                                />
                            )}
                        </label>
                        {backup ? null : (
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={trustDevice}
                                    onChange={(event) => setTrustDevice(event.target.checked)}
                                />
                                {t("twoFactor.trustDevice")}
                            </label>
                        )}
                        {shownError ? <p className="text-sm text-danger">{shownError}</p> : null}
                        <Button
                            type="submit"
                            disabled={pending || (backup ? code.trim() === "" : !isWholeCode(code))}
                        >
                            {pending ? t("twoFactor.verifying") : t("twoFactor.verify")}
                        </Button>
                    </form>

                    <button
                        type="button"
                        className="mt-4 flex w-full items-center justify-center gap-1 text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => {
                            setBackup(!backup);
                            setCode("");
                            setError(null);
                        }}
                    >
                        <KeyRound className="size-3" />
                        {backup ? t("twoFactor.usualMethod") : t("twoFactor.useBackup")}
                    </button>

                    {/* The way out. Without it the sign-in page keeps resuming this
                        challenge, so somebody who cannot finish it - wrong account,
                        no authenticator to hand - would be stuck here until it
                        expired. */}
                    <button
                        type="button"
                        disabled={pending}
                        className="mt-2 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => {
                            dropHeldPassword();
                            void abandonChallengeAction();
                        }}
                    >
                        {t("twoFactor.someoneElse")}
                    </button>
                </CardBody>
            </Card>
        </main>
    );
}

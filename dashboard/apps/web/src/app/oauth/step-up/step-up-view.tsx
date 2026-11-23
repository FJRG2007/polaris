"use client";

/**
 * The extra steps of a sign-in: one more method, the security questions, or
 * both, with how far along the sign-in is. Every answer goes to the server, which
 * is the only thing that decides whether the session opens.
 */

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Mail, MessageSquare, Smartphone } from "lucide-react";
import { WhatsAppLogo } from "../2fa/whatsapp-logo";
import { TelegramLogo } from "../2fa/telegram-logo";
import type { TwoFactorMethod } from "@polaris/core";
import type { StepUpReason } from "@/lib/two-factor-policy";
import { CodeInput, isWholeCode } from "@/components/code-input";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, type ComponentType, type FormEvent } from "react";
import { useCodeSending } from "@/components/use-code-sending";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PhoneInput, PolarisMark } from "@polaris/ui";
import {
    answerStepUpQuestionsAction,
    proveStepUpFactorAction,
    sendStepUpFactorCodeAction,
    type StepUpResult
} from "./actions";

const METHOD_ICON: Record<TwoFactorMethod, ComponentType<{ className?: string }>> = {
    totp: Smartphone,
    email: Mail,
    whatsapp: WhatsAppLogo,
    sms: MessageSquare,
    telegram: TelegramLogo
};

export function StepUpView({
    reason,
    progress,
    methods,
    questions,
    phoneHint,
    phoneConfirmed,
    emailHint,
    emailConfirmed
}: {
    reason: StepUpReason;
    progress: { done: number; total: number };
    methods: Array<{ method: TwoFactorMethod; target: string | null }>;
    questions: string[];
    /** The number a WhatsApp code would go to, masked. */
    phoneHint: string | null;
    phoneConfirmed: boolean;
    /** The address an email code would go to, as f***@g***.com. */
    emailHint: string | null;
    emailConfirmed: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("auth");
    const [picked, setMethod] = useState<TwoFactorMethod | null>(methods[0]?.method ?? null);
    // A method answered a moment ago drops off the list on refresh; the next one
    // owed takes its place rather than leaving a field for something already done.
    const method = methods.some((option) => option.method === picked) ? picked : (methods[0]?.method ?? null);
    const [code, setCode] = useState("");
    const [phone, setPhone] = useState("");
    const [email, setEmail] = useState("");
    const [answers, setAnswers] = useState<string[]>(questions.map(() => ""));
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The questions come once the methods are done, so one step shows at a time.
    const askingQuestions = methods.length === 0 && questions.length > 0;
    const needsPhone = (method === "whatsapp" || method === "sms") && !phoneConfirmed;
    const needsEmail = method === "email" && !emailConfirmed;
    const needsSending = method !== null && method !== "totp";

    async function run(action: () => Promise<StepUpResult>): Promise<StepUpResult> {
        setPending(true);
        setError(null);
        const result = await action().catch(() => ({ error: t("stepUp.failed") }) as StepUpResult);
        setPending(false);
        if (result.error) setError(result.error);
        if (result.complete) router.replace("/");
        return result;
    }

    function choose(next: TwoFactorMethod) {
        setMethod(next);
        setCode("");
        setError(null);
    }

    // Sent by itself on entering a method that delivers, unless a number has to
    // be typed first; the button is the resend (components/use-code-sending.ts).
    const sending = useCodeSending({
        scope: needsSending && method ? `step-up:${method}` : null,
        auto: !needsPhone && !needsEmail,
        send: async () => {
            if (!method || method === "totp") return { error: "" };
            const typedPhone = needsPhone;
            const typedEmail = needsEmail;
            const result = await run(() =>
                sendStepUpFactorCodeAction({
                    method,
                    phone: typedPhone ? phone : undefined,
                    email: typedEmail ? email : undefined
                })
            );
            if (result.error || result.complete) return { error: "" };
            if (typedPhone || typedEmail) router.refresh();
            return {};
        }
    });
    const sent = sending.sent;

    async function verify(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!method) return;
        const result = await run(() => proveStepUpFactorAction({ method, code }));
        if (!result.error && !result.complete) {
            setCode("");
            router.refresh();
        }
    }

    async function answer(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await run(() => answerStepUpQuestionsAction({ answers }));
    }

    async function leave() {
        setPending(true);
        await signOut().catch(() => undefined);
        router.replace("/oauth/login");
    }

    // A backup code always gets a sign-in through on its own, but it is taken at
    // the second step of a sign-in, not here: this session already used that step.
    const [backupHint, setBackupHint] = useState(false);

    return (
        <main className="grid min-h-dvh grid-cols-[minmax(0,1fr)] place-items-center safe-p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center text-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("stepUp.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                        {t("stepUp.progress", { current: Math.min(progress.done + 1, progress.total), total: progress.total })}
                    </p>
                    <p className="text-sm text-muted-foreground">{t(`stepUp.reasons.${reason}`)}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {askingQuestions ? (
                        <form onSubmit={answer} className="flex flex-col gap-3">
                            <p className="text-sm">{t("stepUp.questionsIntro")}</p>
                            {questions.map((question, index) => (
                                <label key={question} className="flex min-w-0 flex-col gap-1 text-sm">
                                    <span className="break-words">{question}</span>
                                    <Input
                                        value={answers[index] ?? ""}
                                        autoComplete="off"
                                        required
                                        maxLength={200}
                                        onChange={(event) =>
                                            setAnswers((current) =>
                                                current.map((value, at) => (at === index ? event.target.value : value))
                                            )
                                        }
                                    />
                                </label>
                            ))}
                            {error ? <p className="text-sm text-danger">{error}</p> : null}
                            <Button type="submit" disabled={pending || answers.some((value) => value.trim() === "")}>
                                {pending ? t("twoFactor.verifying") : t("twoFactor.verify")}
                            </Button>
                        </form>
                    ) : (
                        <>
                            {methods.length > 1 ? (
                                <div className="flex flex-col gap-1">
                                    <p className="text-sm">{t("stepUp.pick")}</p>
                                    {methods.map((option) => {
                                        const Icon = METHOD_ICON[option.method];
                                        const active = option.method === method;
                                        return (
                                            <button
                                                key={option.method}
                                                type="button"
                                                onClick={() => choose(option.method)}
                                                aria-pressed={active}
                                                className={`flex items-center gap-3 rounded-md border px-3 py-2 text-start text-sm transition ${
                                                    active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                                                }`}
                                            >
                                                <Icon className="size-4 shrink-0 text-muted-foreground" />
                                                <span className="min-w-0">
                                                    <span className="block">{t(`twoFactor.methods.${option.method}.label`)}</span>
                                                    <span className="block truncate text-xs text-muted-foreground">
                                                        {option.target ?? t(`twoFactor.methods.${option.method}.description`)}
                                                    </span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}

                            {needsPhone ? (
                                <div className="flex flex-col gap-1 text-sm">
                                    <label htmlFor="step-up-phone">
                                        {phoneHint ? t("stepUp.phoneLabel", { hint: phoneHint }) : t("stepUp.phoneLabelPlain")}
                                    </label>
                                    <PhoneInput id="step-up-phone" value={phone} onChange={setPhone} />
                                </div>
                            ) : null}

                            {needsEmail ? (
                                <div className="flex flex-col gap-1 text-sm">
                                    <label htmlFor="step-up-email" className="break-words">
                                        {emailHint ? t("stepUp.emailLabel", { hint: emailHint }) : t("stepUp.emailLabelPlain")}
                                    </label>
                                    <Input
                                        id="step-up-email"
                                        type="email"
                                        autoComplete="email"
                                        maxLength={320}
                                        value={email}
                                        onChange={(event) => setEmail(event.target.value)}
                                    />
                                </div>
                            ) : null}

                            {needsSending ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={
                                        pending ||
                                        sending.cooldown > 0 ||
                                        (needsPhone && phone.trim().length < 6) ||
                                        (needsEmail && !email.includes("@"))
                                    }
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
                            {sent ? <p className="text-sm text-success">{t("twoFactor.sent")}</p> : null}

                            {method ? (
                                <form onSubmit={verify} className="flex flex-col gap-3">
                                    <label className="flex flex-col gap-1 text-sm">
                                        {method === "totp" ? t("twoFactor.authenticatorCode") : t("twoFactor.sentCode")}
                                        <CodeInput name="code" autoSubmit value={code} onValueChange={setCode} required />
                                    </label>
                                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                                    <Button type="submit" disabled={pending || !isWholeCode(code)}>
                                        {pending ? t("twoFactor.verifying") : t("twoFactor.verify")}
                                    </Button>
                                </form>
                            ) : (
                                <>
                                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                                    <p className="text-sm text-muted-foreground">{t("stepUp.nothingLeft")}</p>
                                </>
                            )}
                        </>
                    )}

                    {backupHint ? (
                        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-sm">
                            <p>{t("stepUp.backupHint")}</p>
                            <Button type="button" variant="outline" disabled={pending} onClick={() => void leave()}>
                                {t("stepUp.backupSignIn")}
                            </Button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            disabled={pending}
                            className="mt-1 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() => setBackupHint(true)}
                        >
                            {t("stepUp.useBackup")}
                        </button>
                    )}

                    <button
                        type="button"
                        disabled={pending}
                        className="mt-2 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => void leave()}
                    >
                        {t("stepUp.signOut")}
                    </button>
                </CardBody>
            </Card>
        </main>
    );
}

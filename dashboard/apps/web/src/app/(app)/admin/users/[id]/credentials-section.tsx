"use client";

/**
 * Getting somebody back into their account, and moving it to another address.
 *
 * Each action asks the administrator for a fresh step-up proof the first time
 * (the server refuses without one and says so), then runs. The reset link is
 * shown once: it lives in this component's state and nowhere else, so leaving
 * the page is the end of it.
 */

import { useAccountAction } from "./use-account-action";
import { StepUpDialog } from "@/components/step-up-dialog";
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Link2, Mail, Wand2 } from "lucide-react";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CredentialOptions } from "@/lib/admin-credentials-service";
import { Button, Card, CardBody, Checkbox, CopyButton, Input } from "@polaris/ui";
import { accountEmailSchema, temporaryPasswordSchema } from "./credential-schemas";
import {
    changeAccountEmailAction,
    credentialOptionsAction,
    issueResetLinkAction,
    mailResetLinkAction,
    setTemporaryPasswordAction
} from "./credentials-actions";

/** Letters and digits that cannot be misread when said aloud or copied by hand. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A password to read out, from the browser's own random source. */
function generatePassword(length = 16): string {
    const bytes = crypto.getRandomValues(new Uint32Array(length));
    return Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length]).join("");
}

type Outcome = { error?: string; stepUp?: boolean };

export function CredentialsSection({ user, isSelf }: { user: DirectoryUser; isSelf: boolean }) {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    const { busy, error, run, setError } = useAccountAction();
    const [options, setOptions] = useState<CredentialOptions | null>(null);
    const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [email, setEmail] = useState("");
    const [verified, setVerified] = useState(false);
    const [keepOld, setKeepOld] = useState(true);
    /** The action waiting on a step-up proof, run again once it is given. */
    const [waiting, setWaiting] = useState<(() => Promise<void>) | null>(null);

    useEffect(() => {
        if (isSelf) return;
        void credentialOptionsAction(user.id).then((result) => setOptions("error" in result ? null : result));
    }, [user.id, isSelf]);

    /** Run an action; a refusal that wants a proof opens the dialog and retries. */
    async function guarded(action: () => Promise<Outcome>, done: () => void): Promise<void> {
        setNotice(null);
        const attempt = async () => {
            let refusal: Outcome = {};
            const ok = await run(async () => {
                refusal = await action();
                return refusal.stepUp ? {} : refusal;
            });
            if (refusal.stepUp) {
                setWaiting(() => attempt);
                return;
            }
            if (ok) done();
        };
        await attempt();
    }

    const passwordCheck = temporaryPasswordSchema.safeParse({ password });
    const emailCheck = accountEmailSchema.safeParse({ email, verified, keepOld });
    const emailUnchanged = emailCheck.success && emailCheck.data.email === user.email;
    const mailReason =
        options?.mailBlocker === "noChannel"
            ? t("usersDetail.credentials.mail.noChannel")
            : options?.mailBlocker === "unverified"
              ? t("usersDetail.credentials.mail.unverified")
              : null;

    function onIssueLink() {
        void guarded(
            async () => {
                const result = await issueResetLinkAction(user.id);
                if (result.url && result.expiresAt) setLink({ url: result.url, expiresAt: result.expiresAt });
                return result;
            },
            () => undefined
        );
    }

    function onMailLink() {
        void guarded(
            () => mailResetLinkAction(user.id),
            () => setNotice(t("usersDetail.credentials.mail.sent", { email: user.email }))
        );
    }

    function onTemporary(event: FormEvent) {
        event.preventDefault();
        if (!passwordCheck.success) return;
        void guarded(
            () => setTemporaryPasswordAction(user.id, { password }),
            () => setNotice(t("usersDetail.credentials.temporary.done", { name: user.name }))
        );
    }

    function onEmail(event: FormEvent) {
        event.preventDefault();
        if (!emailCheck.success || emailUnchanged) return;
        void guarded(
            () => changeAccountEmailAction(user.id, emailCheck.data),
            () => {
                setEmail("");
                setNotice(t("usersDetail.credentials.email.done"));
            }
        );
    }

    if (isSelf) {
        return (
            <Card>
                <CardBody>
                    <p className="text-sm text-muted-foreground">{t("usersDetail.credentials.self")}</p>
                </CardBody>
            </Card>
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-5">
                <section className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">{t("usersDetail.credentials.title")}</h2>
                        <p className="text-xs text-muted-foreground">
                            {t("usersDetail.credentials.hint", { name: user.name })}
                        </p>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm">
                                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                                {t("usersDetail.credentials.link.title")}
                            </p>
                            <p className="text-xs text-muted-foreground">{t("usersDetail.credentials.link.hint")}</p>
                        </div>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={onIssueLink}>
                            {t("usersDetail.credentials.link.create")}
                        </Button>
                    </div>
                    {link ? (
                        <div className="flex flex-col gap-1 rounded-lg bg-muted p-3">
                            <div className="flex items-center gap-2">
                                <code className="min-w-0 flex-1 truncate text-xs" title={link.url}>
                                    {link.url}
                                </code>
                                <CopyButton value={link.url} label={t("usersDetail.credentials.link.copy")} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {t("usersDetail.credentials.link.once", { time: format.dateTime(link.expiresAt) })}
                            </p>
                        </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm">
                                <Mail className="size-4 shrink-0 text-muted-foreground" />
                                {t("usersDetail.credentials.mail.title")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {mailReason ?? t("usersDetail.credentials.mail.hint", { email: user.email })}
                            </p>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || options === null || mailReason !== null}
                            title={mailReason ?? undefined}
                            onClick={onMailLink}
                        >
                            {t("usersDetail.credentials.mail.send")}
                        </Button>
                    </div>
                    <form onSubmit={onTemporary} noValidate className="flex flex-col gap-2">
                        <p className="flex items-center gap-1.5 text-sm">
                            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                            {t("usersDetail.credentials.temporary.title")}
                        </p>
                        <p className="text-xs text-muted-foreground">{t("usersDetail.credentials.temporary.hint")}</p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            {/* enigma:allow-identity-password - an administrator types this for
                                somebody else, so there is no identity on this side to compare;
                                setTemporaryPassword refuses one matching the account's own name,
                                email or handle, and a breached one, on the server. */}
                            <Input
                                type="password"
                                className="flex-1"
                                autoComplete="new-password"
                                aria-label={t("usersDetail.credentials.temporary.label")}
                                placeholder={t("usersDetail.credentials.temporary.placeholder")}
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                            />
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={t("usersDetail.credentials.temporary.generate")}
                                title={t("usersDetail.credentials.temporary.generate")}
                                onClick={() => setPassword(generatePassword())}
                            >
                                <Wand2 className="size-4" />
                            </Button>
                            {password ? (
                                <CopyButton value={password} label={t("usersDetail.credentials.temporary.copy")} />
                            ) : null}
                            <Button type="submit" size="sm" disabled={busy} aria-disabled={!passwordCheck.success}>
                                {t("usersDetail.credentials.temporary.set")}
                            </Button>
                        </div>
                    </form>
                </section>

                <form onSubmit={onEmail} noValidate className="flex flex-col gap-2 border-t border-border pt-4">
                    <div>
                        <h2 className="text-sm font-medium">{t("usersDetail.credentials.email.title")}</h2>
                        <p className="text-xs text-muted-foreground">
                            {t("usersDetail.credentials.email.hint", { email: user.email })}
                        </p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                            type="email"
                            className="flex-1"
                            autoComplete="off"
                            aria-label={t("usersDetail.credentials.email.label")}
                            placeholder={t("usersDetail.credentials.email.placeholder")}
                            value={email}
                            aria-invalid={email.trim() && !emailCheck.success ? true : undefined}
                            onChange={(event) => setEmail(event.target.value)}
                        />
                        <Button
                            type="submit"
                            size="sm"
                            disabled={busy}
                            aria-disabled={!emailCheck.success || emailUnchanged}
                        >
                            {t("usersDetail.credentials.email.save")}
                        </Button>
                    </div>
                    {email.trim() && !emailCheck.success ? (
                        <p className="text-xs text-danger">{t("usersDetail.credentials.email.invalid")}</p>
                    ) : null}
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={verified} onChange={(event) => setVerified(event.target.checked)} />
                        {t("usersDetail.credentials.email.verified")}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={keepOld} onChange={(event) => setKeepOld(event.target.checked)} />
                        {t("usersDetail.credentials.email.keepOld", { email: user.email })}
                    </label>
                </form>

                {notice ? <p className="text-sm text-success">{notice}</p> : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
            <StepUpDialog
                open={waiting !== null}
                purpose="admin-credentials"
                title={t("usersDetail.credentials.stepUp.title")}
                description={t("usersDetail.credentials.stepUp.description", { name: user.name })}
                onOpenChange={(open) => {
                    if (!open) {
                        setWaiting(null);
                        setError(null);
                    }
                }}
                onProved={async () => {
                    const next = waiting;
                    setWaiting(null);
                    await next?.();
                }}
            />
        </Card>
    );
}

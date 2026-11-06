"use client";

/**
 * Replacing a temporary password. The breach and identity checks run here for
 * the person typing; the server runs them again and decides.
 */

import { useState, type FormEvent } from "react";
import { signOut } from "@/lib/auth-client";
import { replaceTemporaryPasswordAction } from "./actions";
import { usePasswordSafety } from "@/lib/use-password-safety";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";

/** The shortest password the server accepts. */
const MIN_PASSWORD = 10;

export function ChangePasswordForm({ account, name }: { account: string; name: string }) {
    const t = useTranslations("auth");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const unsafe = usePasswordSafety(password, [account, name, account.split("@")[0], "polaris"]);
    const mismatch = confirm.length > 0 && confirm !== password;
    const ready = password.length >= MIN_PASSWORD && confirm === password && !unsafe;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (!ready || pending) return;
        setPending(true);
        setError(null);
        const result = await replaceTemporaryPasswordAction({ newPassword: password });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        // A full navigation, so the guard reads the cleared hold on a fresh request.
        window.location.assign("/");
    }

    async function onSignOut() {
        setError(null);
        const refused = await signOut();
        if (refused) setError(refused);
    }

    return (
        <main className="grid min-h-dvh place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("changePassword.title")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="text-sm text-muted-foreground">{t("changePassword.intro")}</p>
                    <form onSubmit={onSubmit} noValidate className="mt-3 flex flex-col gap-3">
                        <input
                            type="text"
                            autoComplete="username"
                            value={account}
                            readOnly
                            hidden
                        />
                        {/* enigma:allow-identity-password - the refusal is usePasswordSafety above,
                            fed the account's email, its local part and name; the server refuses
                            the same in unacceptablePassword. */}
                        <Input
                            type="password"
                            aria-label={t("changePassword.new")}
                            placeholder={t("changePassword.placeholder", { count: MIN_PASSWORD })}
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            aria-invalid={unsafe ? true : undefined}
                        />
                        {unsafe ? <p className="text-sm text-danger">{unsafe}</p> : null}
                        {/* enigma:allow-identity-password - the refusal is usePasswordSafety above,
                            fed the account's email, its local part and name; the server refuses
                            the same in unacceptablePassword. */}
                        <Input
                            type="password"
                            aria-label={t("changePassword.confirm")}
                            placeholder={t("changePassword.confirm")}
                            autoComplete="new-password"
                            value={confirm}
                            onChange={(event) => setConfirm(event.target.value)}
                            aria-invalid={mismatch ? true : undefined}
                        />
                        {mismatch ? (
                            <p className="text-sm text-danger">{t("changePassword.mismatch")}</p>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending} aria-disabled={!ready}>
                            {pending ? t("changePassword.saving") : t("changePassword.save")}
                        </Button>
                        <button
                            type="button"
                            className="text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                            onClick={() => void onSignOut()}
                        >
                            {t("changePassword.signOut")}
                        </button>
                    </form>
                </CardBody>
            </Card>
        </main>
    );
}

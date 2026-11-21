"use client";

/**
 * The security-key step: sign in again with a passkey or a security key, or
 * register the first one and then sign in with it.
 *
 * The new sign-in replaces this session's cookie with one whose sign-in was a
 * key, which is what the requirement asks for; registering a key alone does not,
 * since the session was still opened with something a look-alike site can
 * collect. Cross-platform keys (YubiKey, SoloKey, Titan) and the device's own
 * passkeys are both offered: nothing here narrows the authenticator.
 */

import { KeyRound } from "lucide-react";
import { authClient, signOut } from "@/lib/auth-client";
import { useEffect, useState, type FormEvent } from "react";
import { rememberLocalPasskey } from "@/lib/local-passkeys";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PASSKEY_NAME_MAX, passkeyRelyingPartyId } from "@polaris/core";
import { knownMessage } from "@/app/(app)/account/security/known-sentences";
import { confirmPasswordForKeyAction, noteKeyAddedAction } from "./actions";
import { signInWithPasskeys, type PasskeyDescriptor } from "@/lib/passkey-sign-in";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";

export function SecurityKeyView({
    account,
    name,
    keys,
    names
}: {
    account: string;
    name: string;
    keys: PasskeyDescriptor[];
    names: string[];
}) {
    const t = useTranslations("auth");
    const ts = useTranslations("accountSecurity");
    const tv = useTranslations("validation");
    const [supported, setSupported] = useState<boolean | null>(null);
    const [allow, setAllow] = useState(keys);
    const [label, setLabel] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [added, setAdded] = useState(false);

    useEffect(() => {
        setSupported(
            window.isSecureContext &&
                typeof window.PublicKeyCredential === "function" &&
                passkeyRelyingPartyId(window.location.hostname) !== null
        );
    }, []);

    const trimmed = label.trim();
    const taken = names.some((existing) => existing.trim().toLowerCase() === trimmed.toLowerCase());

    async function signIn() {
        setBusy(true);
        setError(null);
        const result = await signInWithPasskeys(allow);
        if (result.error) {
            setBusy(false);
            setError(t("securityKey.notCompleted"));
            return;
        }
        // A full load, so the dashboard is asked for with the new session's cookie.
        window.location.assign("/");
    }

    async function register(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!trimmed || taken) return;
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const proved = await confirmPasswordForKeyAction(password);
        if (proved.error) {
            setBusy(false);
            setError(proved.error);
            return;
        }
        const result = await authClient.passkey.addPasskey({ name: trimmed, returnWebAuthnResponse: true });
        setBusy(false);
        if (result?.error) {
            setError(
                result.error.message
                    ? knownMessage(ts, tv, result.error.message)
                    : t("securityKey.notCompleted")
            );
            return;
        }
        const created = (result as { webauthn?: { response?: { id: string; authenticatorAttachment?: string } } })
            .webauthn?.response;
        if (created) {
            rememberLocalPasskey(created);
            setAllow((current) => [...current, { id: created.id, transports: [] }]);
        }
        await noteKeyAddedAction().catch(() => undefined);
        setAdded(true);
    }

    async function onSignOut() {
        setError(null);
        const refused = await signOut();
        if (refused) setError(refused);
    }

    const hasKey = allow.length > 0;

    return (
        <main className="grid min-h-dvh place-items-center safe-p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle className="text-center">{t("securityKey.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {t("securityKey.intro", { name, account })}
                    </p>
                    {supported === false ? (
                        <p className="text-sm text-danger">{t("securityKey.unsupported")}</p>
                    ) : hasKey ? (
                        <>
                            {added ? <p className="text-sm text-success">{t("securityKey.added")}</p> : null}
                            <Button onClick={() => void signIn()} disabled={busy || supported !== true}>
                                <KeyRound className="size-4 shrink-0" />
                                {busy ? t("securityKey.signingIn") : t("securityKey.signIn")}
                            </Button>
                            <p className="text-xs text-muted-foreground">{t("securityKey.signInHint")}</p>
                        </>
                    ) : (
                        <form onSubmit={(event) => void register(event)} className="flex flex-col gap-3">
                            <p className="text-sm">{t("securityKey.none")}</p>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("securityKey.name")}
                                <Input
                                    value={label}
                                    maxLength={PASSKEY_NAME_MAX}
                                    placeholder={t("securityKey.namePlaceholder")}
                                    aria-invalid={taken || undefined}
                                    onChange={(event) => setLabel(event.target.value)}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("securityKey.password")}
                                <Input name="password" type="password" required autoComplete="current-password" />
                            </label>
                            <Button
                                type="submit"
                                disabled={busy || supported !== true}
                                aria-disabled={!trimmed || taken}
                            >
                                {busy ? t("securityKey.adding") : t("securityKey.add")}
                            </Button>
                        </form>
                    )}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <button
                        type="button"
                        className="text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        onClick={() => void onSignOut()}
                    >
                        {t("securityKey.signOut")}
                    </button>
                </CardBody>
            </Card>
        </main>
    );
}

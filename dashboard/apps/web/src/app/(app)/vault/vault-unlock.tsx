"use client";

/**
 * The lock screen.
 *
 * Nothing is asked of the server here. The wrapped key came down with the page,
 * the master password is turned into a key in this tab, and either it unwraps or
 * it does not - so a wrong password costs a derivation and no round trip, and
 * the server never learns that somebody guessed.
 *
 * The derivation is deliberately slow (600,000 PBKDF2 rounds by default), which
 * is why the button says what it is doing: a second of nothing looks broken.
 */

import * as core from "@polaris/core";
import * as passkeyClient from "@/lib/vault/passkey-client";
import { KeyRound, Loader2, Lock } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { VaultPasskeyEntry } from "@/lib/vault/passkey-schema";
import { vaultPasskeyUsedAction } from "./passkey-actions";
import type { KdfSettings } from "@polaris/core";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { unlockVaultKey, type SymmetricKey } from "@/lib/vault/crypto";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function VaultUnlock({
    email,
    kdf,
    protectedKey,
    passkeys,
    notice,
    onUnlocked
}: {
    email: string;
    kdf: KdfSettings;
    protectedKey: string;
    /** Passkeys enrolled to unlock this vault, wrapped key and all. */
    passkeys?: VaultPasskeyEntry[];
    /** Why it locked, when something other than the deadline did it. */
    notice?: string | null;
    onUnlocked: (key: SymmetricKey) => void;
}) {
    const t = useTranslations("vault");
    const [password, setPassword] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The enrolled passkeys this address can use, and whether this browser
     *  can ask them for a PRF output. Read after mount: neither exists on the
     *  server that drew the page. */
    const [usable, setUsable] = useState<VaultPasskeyEntry[]>([]);
    const [support, setSupport] = useState<passkeyClient.PasskeySupport | null>(null);
    useEffect(() => {
        setUsable(passkeyClient.usablePasskeys(passkeys));
        void passkeyClient.passkeySupport().then(setSupport);
    }, [passkeys]);
    const passkeyBlocked = support === "no-webauthn" || support === "no-prf";

    async function onPasskey() {
        setPending(true);
        setError(null);
        try {
            const result = await passkeyClient.unlockWithPasskey(usable);
            if ("failure" in result) {
                setError(
                    result.failure === "cancelled"
                        ? t("passkeys.cancelled")
                        : result.failure === "no-prf"
                          ? t("passkeys.noPrfPasskey")
                          : result.failure === "wrong"
                            ? t("passkeys.wrong")
                            : result.failure === "stale"
                              ? t("passkeys.stale")
                              : t("passkeys.failed")
                );
                return;
            }
            onUnlocked(result.key);
            // Only a record for the settings list; the vault is already open.
            void vaultPasskeyUsedAction(result.id).catch(() => undefined);
        } catch {
            setError(t("passkeys.failed"));
        } finally {
            setPending(false);
        }
    }

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
            const key = await unlockVaultKey(password, email, kdf, protectedKey);
            if (!key) {
                setError(t("errors.wrongMaster"));
                return;
            }
            onUnlocked(key);
        } catch {
            setError(t("unlock.noCrypto"));
        } finally {
            setPending(false);
        }
    }

    return (
        <div className="mx-auto flex w-full max-w-sm flex-col gap-4 py-12">
            <Card>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <div className="flex flex-col items-center gap-2 pb-2 text-center">
                            <Lock className="size-5 text-muted-foreground" />
                            <div>
                                <p className="text-sm font-medium">{t("unlock.title")}</p>
                                <p className="text-xs text-muted-foreground">{email}</p>
                            </div>
                        </div>
                        {notice ? (
                            <p className="text-center text-xs text-muted-foreground">{notice}</p>
                        ) : null}
                        <Input
                            type="password"
                            autoFocus
                            required
                            autoComplete="current-password"
                            placeholder={t("settings.master")}
                            aria-label={t("settings.master")}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                        {/* Said rather than left to a button that does nothing:
                            a disabled control with no explanation reads as a
                            broken page. */}
                        {password.length > 0 && !core.couldBeMasterPassword(password) ? (
                            <p className="text-xs text-muted-foreground">
                                {t("unlock.tooShort", { count: core.MASTER_PASSWORD_MIN })}
                            </p>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        {usable.length > 0 && support !== null ? (
                            passkeyBlocked ? (
                                <p
                                    className="text-center text-xs text-muted-foreground"
                                    data-testid="passkey-unavailable"
                                >
                                    {support === "no-prf"
                                        ? t("passkeys.noPrfBrowser")
                                        : t("passkeys.noWebAuthn")}
                                </p>
                            ) : (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    disabled={pending}
                                    onClick={() => void onPasskey()}
                                >
                                    <KeyRound className="size-4" />
                                    {t("passkeys.unlock")}
                                </Button>
                            )
                        ) : null}
                        {/* Nothing that could never have been the password is
                            sent: a wrong guess costs a key derivation on this
                            machine and a request the server has to rate-limit.
                            Only the length is checked - a vault made before a
                            rule existed still has to open, and refusing on
                            anything newer would lock somebody out of their own
                            vault to enforce a rule invented after they filled
                            it. */}
                        <Button
                            type="submit"
                            disabled={pending || !core.couldBeMasterPassword(password)}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {pending ? t("unlock.deriving") : t("unlock.unlock")}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    );
}

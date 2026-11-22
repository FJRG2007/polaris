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
import * as localPasskeys from "@/lib/local-passkeys";
import { KeyRound, Loader2, Lock } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
    autoPasskey = true,
    notice,
    onUnlocked
}: {
    email: string;
    kdf: KdfSettings;
    protectedKey: string;
    /** Passkeys enrolled to unlock this vault, wrapped key and all. */
    passkeys?: VaultPasskeyEntry[];
    /** Ask for a passkey this browser has used before as soon as the screen
     *  opens, rather than waiting for the button. */
    autoPasskey?: boolean;
    /** Why it locked, when something other than the deadline did it. */
    notice?: string | null;
    onUnlocked: (key: SymmetricKey) => void;
}) {
    const t = useTranslations("vault");
    const [password, setPassword] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Which enrolled passkeys this screen offers (`passkeyOffer`). Read after
     *  mount: the address, the browser's support and the passkeys that have
     *  answered here exist only in this tab, not on the server that drew it. */
    const [offer, setOffer] = useState<passkeyClient.PasskeyOffer | null>(null);
    useEffect(() => {
        let live = true;
        void passkeyClient.passkeySupport().then((support) => {
            if (!live) return;
            setOffer(
                passkeyClient.passkeyOffer({
                    usable: passkeyClient.usablePasskeys(passkeys),
                    support,
                    localIds: localPasskeys.localPasskeyIds(),
                    answeredIds: localPasskeys.answeredPasskeyIds(),
                    inApp: core.clientFromUserAgent(navigator.userAgent) === "desktop"
                })
            );
        });
        return () => {
            live = false;
        };
    }, [passkeys]);

    // Ask on its own once per lock screen, and only for the enrolled passkeys
    // this browser has itself used (`lib/local-passkeys`) - never one that lives
    // on another device. Waits until somebody is at the screen, so a vault that
    // locked while its owner was away does not time a prompt out on its own. A
    // dismissed prompt leaves the screen as it was and this tab asks no more.
    const asked = useRef(false);
    useEffect(() => {
        if (!autoPasskey || asked.current || offer?.kind !== "offer") return;
        if (localPasskeys.automaticPasskeyPaused()) return;
        const candidates = [...offer.automatic];
        if (candidates.length === 0) return;
        const controller = new AbortController();
        void localPasskeys.whenAttended(controller.signal).then((attended) => {
            if (!attended || asked.current) return;
            asked.current = true;
            void onPasskey(candidates, true);
        });
        return () => controller.abort();
    }, [autoPasskey, offer]);

    async function onPasskey(entries: readonly VaultPasskeyEntry[], automatic = false) {
        setPending(true);
        setError(null);
        try {
            const result = await passkeyClient.unlockWithPasskey(entries);
            if ("failure" in result) {
                if (automatic) {
                    // Not an error the person made: they were never asked.
                    if (result.failure === "cancelled") {
                        localPasskeys.missedLocalPasskeys(entries.map((entry) => entry.credentialId));
                    } else {
                        localPasskeys.pauseAutomaticPasskey();
                    }
                    return;
                }
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
            localPasskeys.resumeAutomaticPasskey();
            onUnlocked(result.key);
            // Only a record for the settings list; the vault is already open.
            void vaultPasskeyUsedAction(result.id).catch(() => undefined);
        } catch {
            if (automatic) localPasskeys.pauseAutomaticPasskey();
            else setError(t("passkeys.failed"));
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
                        {offer?.kind === "blocked" || offer?.kind === "not-here" ? (
                            <p
                                className="text-center text-xs text-muted-foreground"
                                data-testid="passkey-unavailable"
                            >
                                {offer.kind === "not-here"
                                    ? t("passkeys.notInApp")
                                    : offer.reason === "no-prf"
                                      ? t("passkeys.noPrfBrowser")
                                      : t("passkeys.noWebAuthn")}
                            </p>
                        ) : offer?.kind === "offer" ? (
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={pending}
                                onClick={() => void onPasskey(offer.entries)}
                            >
                                <KeyRound className="size-4" />
                                {t("passkeys.unlock")}
                            </Button>
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

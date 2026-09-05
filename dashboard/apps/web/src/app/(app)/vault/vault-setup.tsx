"use client";

/**
 * Setting a vault up.
 *
 * The one screen in Polaris where a forgotten password is unrecoverable, and it
 * says so before anything is created rather than afterwards: the master password
 * is what the vault key is wrapped under, nothing on the server can derive it,
 * and there is no reset. A person who has not understood that has not really
 * agreed to it.
 *
 * The keys are minted here, in the browser. What leaves is the wrapped key, the
 * public half of a new pair, and a hash of a hash - and none of that opens
 * anything.
 */

import * as core from "@polaris/core";
import { useState, type FormEvent } from "react";
import { createAccountVaultAction } from "./vault-actions";
import { createVaultKeys } from "@/lib/vault/crypto";
import type { SymmetricKey } from "@/lib/vault/crypto";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { usePasswordSafety } from "@/lib/use-password-safety";

/** Under this, a master password is not protecting anything. */
const MIN_LENGTH = core.MASTER_PASSWORD_MIN;

export function VaultSetup({
    email,
    name,
    onCreated
}: {
    email: string;
    name: string;
    /** Handed the key the browser just minted, so the vault opens straight away
     *  rather than asking for the password that was typed a second ago. */
    onCreated: (key: SymmetricKey) => void;
}) {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [hint, setHint] = useState("");
    const [understood, setUnderstood] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const unsafe = usePasswordSafety(password, [email, name, email.split("@")[0]]);

    const tooShort = password.length > 0 && password.length < MIN_LENGTH;
    const mismatch = confirm.length > 0 && confirm !== password;
    // A hint that contains the password is a hint that hands it over: it is
    // stored in the clear, and shown to anybody who asks for it at sign-in.
    const hintLeaks =
        hint.length > 0 &&
        password.length > 0 &&
        hint.toLowerCase().includes(password.toLowerCase());

    // The shape rule, beside the two this screen already applied: a password that
    // is only one kind of character is a password a list attacks first.
    const weak = core.masterPasswordProblem(password);

    const ready =
        password.length >= MIN_LENGTH &&
        !weak &&
        confirm === password &&
        understood &&
        !unsafe &&
        !hintLeaks;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (!ready) return;
        setPending(true);
        setError(null);
        try {
            const { keys, vaultKey } = await createVaultKeys(
                password,
                email,
                core.DEFAULT_KDF_SETTINGS
            );
            const result = await createAccountVaultAction({
                masterPasswordHash: keys.masterPasswordHash,
                masterPasswordHint: hint.trim() || null,
                key: keys.protectedKey,
                keys: {
                    publicKey: keys.publicKey,
                    encryptedPrivateKey: keys.encryptedPrivateKey
                },
                kdf: core.DEFAULT_KDF_SETTINGS.kdf,
                kdfIterations: core.DEFAULT_KDF_SETTINGS.kdfIterations
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onCreated(vaultKey);
        } catch {
            setError("Your browser could not create the keys. It needs a secure connection.");
        } finally {
            setPending(false);
        }
    }

    return (
        <div className="mx-auto flex max-w-lg flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Set up your vault</h1>
                <p className="text-sm text-muted-foreground">
                    Your master password unlocks everything in it, and it never leaves this browser.
                </p>
            </div>
            <Card>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Master password
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password
                                Both checks ARE run, by usePasswordSafety above - the
                                breach corpus as it is typed and the identity rule
                                immediately. What cannot happen is the usual second
                                pass on the server: the master password never reaches
                                it. A hash of a hash does, and neither check works on
                                that. The client is the only place this can be asked,
                                which is the same trade that makes the vault a vault. */}
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                required
                            />
                            <span className="text-xs text-muted-foreground">
                                At least {MIN_LENGTH} characters. Longer is better than stranger.
                            </span>
                        </label>
                        {tooShort || weak ? (
                            <p className="text-sm text-danger">{weak}</p>
                        ) : null}
                        {unsafe ? <p className="text-sm text-danger">{unsafe}</p> : null}

                        <label className="flex flex-col gap-1 text-sm">
                            Type it again
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password
                                A confirmation field, not a second secret: it is only
                                ever compared with the one above, which both checks
                                have already run against. */}
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(event) => setConfirm(event.target.value)}
                                required
                            />
                        </label>
                        {mismatch ? (
                            <p className="text-sm text-danger">Those do not match.</p>
                        ) : null}

                        <label className="flex flex-col gap-1 text-sm">
                            Hint (optional)
                            <Input
                                value={hint}
                                onChange={(event) => setHint(event.target.value)}
                                placeholder="Something only you would understand"
                            />
                            <span className="text-xs text-muted-foreground">
                                Shown to anybody who asks for it at sign-in, so keep it oblique.
                            </span>
                        </label>
                        {hintLeaks ? (
                            <p className="text-sm text-danger">
                                That hint contains the password itself.
                            </p>
                        ) : null}

                        <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-3">
                            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="mt-0.5 size-4"
                                    checked={understood}
                                    onChange={(event) => setUnderstood(event.target.checked)}
                                />
                                <span>
                                    I understand that forgetting this password means losing
                                    everything in the vault.
                                    <span className="block text-xs text-muted-foreground">
                                        Not even an administrator can reset it. That is what makes
                                        it worth using.
                                    </span>
                                </span>
                            </label>
                        </div>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={!ready || pending}>
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <KeyRound className="size-4" />
                            )}
                            Create my vault
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    );
}

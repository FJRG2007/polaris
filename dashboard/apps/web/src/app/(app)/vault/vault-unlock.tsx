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
import { Loader2, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { KdfSettings } from "@polaris/core";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { unlockVaultKey, type SymmetricKey } from "@/lib/vault/crypto";

export function VaultUnlock({
    email,
    kdf,
    protectedKey,
    notice,
    onUnlocked
}: {
    email: string;
    kdf: KdfSettings;
    protectedKey: string;
    /** Why it locked, when something other than the deadline did it. */
    notice?: string | null;
    onUnlocked: (key: SymmetricKey) => void;
}) {
    const [password, setPassword] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
            const key = await unlockVaultKey(password, email, kdf, protectedKey);
            if (!key) {
                setError("That is not your master password.");
                return;
            }
            onUnlocked(key);
        } catch {
            setError("Your browser could not derive the key. It needs a secure connection.");
        } finally {
            setPending(false);
        }
    }

    return (
        <div className="mx-auto flex max-w-sm flex-col gap-4 py-12">
            <Card>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <div className="flex flex-col items-center gap-2 pb-2 text-center">
                            <Lock className="size-5 text-muted-foreground" />
                            <div>
                                <p className="text-sm font-medium">Your vault is locked</p>
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
                            placeholder="Master password"
                            aria-label="Master password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                        {/* Said rather than left to a button that does nothing:
                            a disabled control with no explanation reads as a
                            broken page. */}
                        {password.length > 0 && !core.couldBeMasterPassword(password) ? (
                            <p className="text-xs text-muted-foreground">
                                A master password here is at least {core.MASTER_PASSWORD_MIN}{" "}
                                characters, so this cannot be it yet.
                            </p>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
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
                            {pending ? "Deriving your key..." : "Unlock"}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    );
}

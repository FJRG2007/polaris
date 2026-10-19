"use client";

/**
 * The passkeys that unlock this vault.
 *
 * Adding one needs the vault unlocked (the key is what gets wrapped) and the
 * master password typed again (the server checks its hash before it stores
 * anything). Removing one leaves the master password exactly as it was, so the
 * way back in never depends on a device.
 */

import Link from "next/link";
import * as crypto from "@/lib/vault/crypto";
import { useVaultSession } from "../vault-session";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import * as passkeyClient from "@/lib/vault/passkey-client";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import {
    VAULT_PASSKEY_NAME_MAX,
    normalizePasskeyName,
    type VaultPasskeyEntry
} from "@/lib/vault/passkey-schema";
import {
    enrollVaultPasskeyAction,
    removeVaultPasskeyAction,
    vaultPasskeyCandidatesAction
} from "../passkey-actions";

type Confirm = (options: {
    title: string;
    description: string;
    confirmLabel: string;
    danger?: boolean;
}) => Promise<boolean>;

export function VaultPasskeys({ confirm }: { confirm: Confirm }) {
    const t = useTranslations("vault");
    const { state, key: vaultKey } = useVaultSession();
    const [entries, setEntries] = useState<VaultPasskeyEntry[]>(state.passkeys ?? []);
    useEffect(() => setEntries(state.passkeys ?? []), [state.passkeys]);
    const [support, setSupport] = useState<passkeyClient.PasskeySupport | null>(null);
    useEffect(() => {
        void passkeyClient.passkeySupport().then(setSupport);
    }, []);
    const [host, setHost] = useState("");
    useEffect(() => setHost(window.location.hostname), []);
    const [name, setName] = useState("");
    const [master, setMaster] = useState("");
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [needsAccountPasskey, setNeedsAccountPasskey] = useState(false);
    const [done, setDone] = useState<string | null>(null);

    const cleanName = String(normalizePasskeyName(name));
    const nameTooLong = cleanName.length > VAULT_PASSKEY_NAME_MAX;
    const canAdd = cleanName.length > 0 && !nameTooLong && master.length > 0 && pending === null;
    const unavailable = support === "no-webauthn" || support === "no-prf";

    function failureText(failure: passkeyClient.PasskeyFailure): string {
        if (failure === "cancelled") return t("passkeys.cancelled");
        if (failure === "no-prf") return t("passkeys.noPrfPasskey");
        return t("passkeys.failed");
    }

    async function onAdd(event: FormEvent) {
        event.preventDefault();
        if (!canAdd || !vaultKey) return;
        setPending("add");
        setError(null);
        setDone(null);
        setNeedsAccountPasskey(false);
        try {
            // Checked here first, against the wrap this tab already has: a
            // mistyped password costs a derivation, not a rate-limited request.
            const masterKey = await crypto.deriveMasterKey(master, state.email, state.kdf);
            const opened = await crypto.decryptBytes(
                state.protectedKey ?? "",
                await crypto.stretchMasterKey(masterKey)
            );
            if (!opened) {
                setError(t("errors.wrongMaster"));
                return;
            }
            const candidates = await vaultPasskeyCandidatesAction();
            if (candidates.length === 0) {
                setNeedsAccountPasskey(true);
                return;
            }
            const result = await passkeyClient.enrollWithPasskey({
                vaultKey,
                candidates,
                name: cleanName,
                masterPasswordHash: await crypto.masterPasswordHash(masterKey, master)
            });
            if ("failure" in result) {
                setError(failureText(result.failure));
                return;
            }
            const saved = await enrollVaultPasskeyAction(result.enrollment);
            if (saved.error) {
                setError(saved.error);
                return;
            }
            setName("");
            setMaster("");
            setDone(t("passkeys.added"));
        } catch {
            setError(t("passkeys.failed"));
        } finally {
            setPending(null);
        }
    }

    async function onRemove(entry: VaultPasskeyEntry) {
        const confirmed = await confirm({
            title: t("passkeys.removeTitle"),
            description: t("passkeys.removeBody", { name: entry.name }),
            confirmLabel: t("passkeys.remove"),
            danger: true
        });
        if (!confirmed) return;
        setError(null);
        setDone(null);
        const before = entries;
        setEntries(before.filter((candidate) => candidate.id !== entry.id));
        setPending(entry.id);
        try {
            const result = await removeVaultPasskeyAction(entry.id);
            if (result.error) {
                setEntries(before);
                setError(result.error);
            }
        } catch {
            setEntries(before);
            setError(t("passkeys.failed"));
        } finally {
            setPending(null);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <KeyRound className="size-4" />
                    {t("passkeys.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("passkeys.body")}</p>
                {entries.length > 0 ? (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {entries.map((entry) => (
                            <li key={entry.id} className="flex items-center gap-3 px-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium" title={entry.name}>
                                        {entry.name}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {entry.lastUsedAt ? (
                                            <>
                                                {t("passkeys.lastUsed")}{" "}
                                                <RelativeTime iso={entry.lastUsedAt} />
                                            </>
                                        ) : (
                                            t("passkeys.neverUsed")
                                        )}
                                        {host && entry.rpId !== host ? (
                                            <span className="font-mono">
                                                {" - "}
                                                {t("passkeys.onlyOn", { host: entry.rpId })}
                                            </span>
                                        ) : null}
                                    </p>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("passkeys.removeNamed", { name: entry.name })}
                                    title={t("passkeys.remove")}
                                    disabled={pending !== null}
                                    onClick={() => void onRemove(entry)}
                                >
                                    {pending === entry.id ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <Trash2 className="size-4" />
                                    )}
                                </Button>
                            </li>
                        ))}
                    </ul>
                ) : null}
                {unavailable ? (
                    <p className="text-sm text-muted-foreground" data-testid="passkey-unavailable">
                        {support === "no-prf"
                            ? t("passkeys.noPrfBrowser")
                            : t("passkeys.noWebAuthn")}
                    </p>
                ) : support === null ? null : (
                    <form onSubmit={onAdd} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            <span>
                                {t("passkeys.name")} <span aria-hidden="true">*</span>
                            </span>
                            <Input
                                value={name}
                                maxLength={VAULT_PASSKEY_NAME_MAX + 8}
                                placeholder={t("passkeys.namePlaceholder")}
                                onChange={(event) => setName(event.target.value)}
                            />
                            {nameTooLong ? (
                                <span className="text-xs text-danger">
                                    {t("passkeys.nameTooLong", { count: VAULT_PASSKEY_NAME_MAX })}
                                </span>
                            ) : null}
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span>
                                {t("settings.master")} <span aria-hidden="true">*</span>
                            </span>
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password
                                The existing master password, typed to prove who this is;
                                it is checked against the vault, not chosen here. */}
                            <Input
                                type="password"
                                autoComplete="current-password"
                                value={master}
                                onChange={(event) => setMaster(event.target.value)}
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("passkeys.masterHint")}
                            </span>
                        </label>
                        {needsAccountPasskey ? (
                            <p className="text-sm text-muted-foreground">
                                {t("passkeys.needsAccountPasskey")}{" "}
                                <Link href="/account/security" className="underline">
                                    {t("passkeys.openSecurity")}
                                </Link>
                            </p>
                        ) : null}
                        {done ? <p className="text-sm text-success">{done}</p> : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end">
                            <Button type="submit" disabled={!canAdd} aria-disabled={!canAdd}>
                                {pending === "add" ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : null}
                                {t("passkeys.add")}
                            </Button>
                        </div>
                    </form>
                )}
                {unavailable && error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

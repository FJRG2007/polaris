"use client";

/**
 * What somebody can change about their own vault, and the two ways out of it.
 *
 * Every one of these needs the master password, and not as a formality: changing
 * it re-wraps the key here, exporting decrypts everything here, and deleting is
 * the only irreversible thing in Polaris that no administrator can undo. So all
 * three start by unlocking, in this tab, and none of them can be done by
 * somebody who merely found the session open.
 */

import * as core from "@polaris/core";
import * as crypto from "@/lib/vault/crypto";
import { useState, type FormEvent } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { VaultImport } from "./vault-import";
import { decryptFolders, decryptItem } from "../vault-model";
import { usePasswordSafety } from "@/lib/use-password-safety";
import { Download, KeyRound, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import {
    changeMasterPasswordAction,
    deauthorizeVaultAction,
    deleteVaultAction,
    vaultContentsAction
} from "../vault-actions";

const MIN_LENGTH = 12;

/** The KDFs somebody can move to, and what each is for. */
const KDF_OPTIONS = [
    { value: String(core.KDF_PBKDF2), label: "PBKDF2 - works everywhere" },
    { value: String(core.KDF_ARGON2ID), label: "Argon2id - harder to attack, slower to unlock" }
];

export function VaultSettings({
    email,
    name,
    kdf,
    protectedKey
}: {
    email: string;
    name: string;
    kdf: core.KdfSettings;
    protectedKey: string;
}) {
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirmValue, setConfirmValue] = useState("");
    const [nextKdf, setNextKdf] = useState(String(kdf.kdf));
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [vaultKey, setVaultKey] = useState<crypto.SymmetricKey | null>(null);
    const [confirm, confirmDialog] = useConfirm();
    const unsafe = usePasswordSafety(next, [email, name, email.split("@")[0]]);

    /** The settings a change would move to. */
    function targetKdf(): core.KdfSettings {
        if (Number(nextKdf) === core.KDF_ARGON2ID) {
            return {
                kdf: core.KDF_ARGON2ID,
                kdfIterations: core.DEFAULT_ARGON2_ITERATIONS,
                kdfMemory: core.DEFAULT_ARGON2_MEMORY_MIB,
                kdfParallelism: core.DEFAULT_ARGON2_PARALLELISM
            };
        }
        return core.DEFAULT_KDF_SETTINGS;
    }

    async function onChangePassword(event: FormEvent) {
        event.preventDefault();
        setError(null);
        setDone(null);
        if (next.length < MIN_LENGTH) {
            setError(`Use at least ${MIN_LENGTH} characters.`);
            return;
        }
        if (next !== confirmValue) {
            setError("Those do not match.");
            return;
        }
        if (unsafe) {
            setError(unsafe);
            return;
        }

        setPending("password");
        try {
            // The vault key does not change - only what it is wrapped under - so
            // nothing inside has to be re-encrypted.
            const vaultKey = await crypto.unlockVaultKey(current, email, kdf, protectedKey);
            if (!vaultKey) {
                setError("That is not your current master password.");
                return;
            }
            const settings = targetKdf();
            const masterKey = await crypto.deriveMasterKey(next, email, settings);
            const stretched = await crypto.stretchMasterKey(masterKey);
            const result = await changeMasterPasswordAction({
                masterPasswordHash: await crypto.masterPasswordHash(
                    await crypto.deriveMasterKey(current, email, kdf),
                    current
                ),
                newMasterPasswordHash: await crypto.masterPasswordHash(masterKey, next),
                key: await crypto.encryptBytes(crypto.symmetricKeyBytes(vaultKey), stretched),
                kdf: settings.kdf,
                kdfIterations: settings.kdfIterations,
                kdfMemory: settings.kdfMemory,
                kdfParallelism: settings.kdfParallelism
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setCurrent("");
            setNext("");
            setConfirmValue("");
            setDone("Your master password has changed. Every app will ask for it again.");
        } finally {
            setPending(null);
        }
    }

    /**
     * Export, in the plain JSON every password manager reads.
     *
     * Deliberately unencrypted and deliberately loud about it: the reason to
     * export is to get out - to another manager, to a printout in a safe - and a
     * file only this vault can open would not do that. It is written by the
     * browser and never touches the server.
     */
    async function onExport() {
        const confirmed = await confirm({
            title: "Export everything, unencrypted?",
            description:
                "The file will hold every password in plain text. Put it somewhere you would put the passwords themselves, and delete it when you are done.",
            confirmLabel: "Export",
            danger: true
        });
        if (!confirmed) return;

        if (!vaultKey) {
            setError("Unlock these tools first.");
            return;
        }
        setPending("export");
        setError(null);
        try {
            const contents = await vaultContentsAction();
            const folders = await decryptFolders(contents.folders, vaultKey);
            const items = [];
            for (const raw of contents.ciphers) items.push(await decryptItem(raw, vaultKey));

            const payload = {
                encrypted: false,
                folders: folders.map((folder) => ({ id: folder.id, name: folder.name })),
                items: items
                    .filter((item) => !item.deleted)
                    .map((item) => ({
                        id: item.id,
                        folderId: item.folderId,
                        type: item.type,
                        name: item.name,
                        notes: item.notes || null,
                        favorite: item.favorite,
                        fields: item.fields.map((field) => ({
                            name: field.name,
                            value: field.value,
                            type: field.type
                        })),
                        login:
                            item.type === core.CIPHER_LOGIN
                                ? {
                                      username: item.login.username || null,
                                      password: item.login.password || null,
                                      totp: item.login.totp || null,
                                      uris: item.login.uris.map((uri) => ({ uri, match: null }))
                                  }
                                : undefined,
                        card: item.type === core.CIPHER_CARD ? item.card : undefined,
                        identity: item.type === core.CIPHER_IDENTITY ? item.identity : undefined,
                        sshKey: item.type === core.CIPHER_SSH_KEY ? item.sshKey : undefined,
                        secureNote:
                            item.type === core.CIPHER_SECURE_NOTE ? { type: 0 } : undefined
                    }))
            };

            const blob = new Blob([JSON.stringify(payload, null, 2)], {
                type: "application/json"
            });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "polaris-vault-export.json";
            anchor.click();
            URL.revokeObjectURL(url);
        } finally {
            setPending(null);
        }
    }

    async function onDelete() {
        const confirmed = await confirm({
            title: "Delete your vault?",
            description:
                "Every item in it goes with it, and nobody - not an administrator - can bring it back. Export first if you want to keep anything.",
            confirmLabel: "Delete it",
            danger: true
        });
        if (!confirmed) return;
        setPending("delete");
        setError(null);
        try {
            const masterKey = await crypto.deriveMasterKey(current, email, kdf);
            const result = await deleteVaultAction({
                masterPasswordHash: await crypto.masterPasswordHash(masterKey, current)
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            window.location.href = "/vault";
        } finally {
            setPending(null);
        }
    }

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Vault settings</h1>
                <p className="text-sm text-muted-foreground">
                    Everything here needs your master password, and does its work in this browser.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Master password</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onChangePassword} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Current master password
                            <Input
                                type="password"
                                autoComplete="current-password"
                                value={current}
                                onChange={(event) => setCurrent(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            New master password
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password
                                Both run here, in usePasswordSafety. Neither can run
                                again on the server: it never sees this password, only
                                a hash of a hash of it. */}
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={next}
                                onChange={(event) => setNext(event.target.value)}
                            />
                        </label>
                        {unsafe ? <p className="text-sm text-danger">{unsafe}</p> : null}
                        <label className="flex flex-col gap-1 text-sm">
                            Type it again
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password
                                A confirmation of the field above, not a second secret. */}
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={confirmValue}
                                onChange={(event) => setConfirmValue(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            How it is derived
                            <Select
                                value={nextKdf}
                                onValueChange={setNextKdf}
                                options={KDF_OPTIONS}
                                aria-label="How the key is derived"
                            />
                            <span className="text-xs text-muted-foreground">
                                Changing this re-derives your key, so it happens with the password.
                            </span>
                        </label>
                        {done ? <p className="text-sm text-success">{done}</p> : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end">
                            <Button type="submit" disabled={pending !== null || current.length === 0}>
                                {pending === "password" ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : null}
                                Change it
                            </Button>
                        </div>
                    </form>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Signed-in apps</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                        End every app&apos;s session without changing your password. They will each
                        ask for it again.
                    </p>
                    <Button
                        variant="secondary"
                        onClick={async () => {
                            await deauthorizeVaultAction();
                            setDone("Every app has been signed out.");
                        }}
                    >
                        Sign them all out
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Import and export</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-md text-sm text-muted-foreground">
                        Both read and write your items in the clear, so both need the master
                        password once. It stays in this tab.
                    </p>
                    <Button
                        variant="secondary"
                        disabled={vaultKey !== null || current.length === 0 || pending !== null}
                        onClick={async () => {
                            setError(null);
                            setPending("unlock");
                            const key = await crypto.unlockVaultKey(current, email, kdf, protectedKey);
                            setPending(null);
                            if (!key) {
                                setError("That is not your master password.");
                                return;
                            }
                            setVaultKey(key);
                        }}
                    >
                        {pending === "unlock" ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <KeyRound className="size-4" />
                        )}
                        {vaultKey ? "Unlocked" : "Unlock these tools"}
                    </Button>
                </CardBody>
            </Card>

            <VaultImport vaultKey={vaultKey} />

            <Card>
                <CardHeader>
                    <CardTitle>Export</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-md text-sm text-muted-foreground">
                        A plain JSON file every password manager can read. It holds your passwords in
                        the clear, which is what makes it portable.
                    </p>
                    <Button variant="secondary" onClick={onExport} disabled={pending !== null}>
                        {pending === "export" ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Download className="size-4" />
                        )}
                        Export
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-danger">
                        <ShieldAlert className="size-4" />
                        Delete this vault
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-md text-sm text-muted-foreground">
                        Everything in it goes. Your Polaris account stays as it is.
                    </p>
                    <Button variant="secondary" onClick={onDelete} disabled={pending !== null}>
                        {pending === "delete" ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Trash2 className="size-4" />
                        )}
                        Delete it
                    </Button>
                </CardBody>
            </Card>
            {confirmDialog}
        </div>
    );
}

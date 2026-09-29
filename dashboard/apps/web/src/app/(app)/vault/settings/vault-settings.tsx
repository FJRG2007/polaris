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
import { VaultImport } from "./vault-import";
import { VaultExport } from "./vault-export";
import { type FormEvent, useEffect, useState } from "react";
import { useVaultSession } from "../vault-session";
import { useConfirm } from "@/components/confirm-dialog";
import { usePasswordSafety } from "@/lib/use-password-safety";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { validationMessage } from "@/components/i18n/validation-message";
import { unlockTimeoutLabel } from "../vault-labels";
import { Clock, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";
import {
    changeMasterPasswordAction,
    deauthorizeVaultAction,
    deleteAccountVaultAction,
    setUnlockTimeoutAction
} from "../vault-actions";

const MIN_LENGTH = 12;


/** Where this browser's choice about site icons is kept. The same key the list
 *  reads - see `vault-app`. */
const FAVICON_KEY = "polaris.vault.favicons";

export function VaultSettings() {
    const { state, name, key: vaultKey, lock, unlockTimeout } = useVaultSession();
    const t = useTranslations("vault");
    const tv = useTranslations("validation");
    /** The KDFs somebody can move to, and what each is for. */
    const kdfOptions = [
        { value: String(core.KDF_PBKDF2), label: t("settings.pbkdf2") },
        { value: String(core.KDF_ARGON2ID), label: t("settings.argon2") }
    ];
    const { email, kdf } = state;
    const protectedKey = state.protectedKey ?? "";
    const [lockAfter, setLockAfter] = useState(String(unlockTimeout));
    /** Whether the list may fetch a site's own icon. Read after mount, like every
     *  other browser-kept preference: what is in this browser's storage is not
     *  what the server built the markup from. */
    const [favicons, setFavicons] = useState(false);
    useEffect(() => {
        try {
            setFavicons(window.localStorage.getItem(FAVICON_KEY) === "on");
        } catch {
            // Storage off, or a private window. Off is the right default anyway.
        }
    }, []);
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirmValue, setConfirmValue] = useState("");
    /** The Polaris account password: proof of who is asking, and the value the
     *  new master password is checked against. */
    const [accountPassword, setAccountPassword] = useState("");
    const [nextKdf, setNextKdf] = useState(String(kdf.kdf));
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();
    const unsafeMessage = usePasswordSafety(next, [email, name, email.split("@")[0]]);
    const unsafe = unsafeMessage ? validationMessage(tv, unsafeMessage) : null;

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
            setError(t("settings.tooShort", { count: MIN_LENGTH }));
            return;
        }
        if (next !== confirmValue) {
            setError(t("settings.mismatch"));
            return;
        }
        if (unsafe) {
            setError(unsafe);
            return;
        }
        // Compared here because this is the only place both values exist. The
        // master password does not reach the server, even to be compared - and
        // two secrets that are one secret protect nothing twice: whoever learns
        // the Polaris password would have the vault with it.
        if (core.passwordsTooAlike(next, accountPassword)) {
            setError(t("settings.samePassword"));
            return;
        }

        setPending("password");
        try {
            // The vault key does not change - only what it is wrapped under - so
            // nothing inside has to be re-encrypted.
            const currentKey = await crypto.unlockVaultKey(current, email, kdf, protectedKey);
            if (!currentKey) {
                setError(t("settings.wrongCurrent"));
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
                // Verified on the server as well: a rule enforced only in a
                // browser is not enforced.
                accountPassword,
                key: await crypto.encryptBytes(crypto.symmetricKeyBytes(currentKey), stretched),
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
            setAccountPassword("");
            setDone(t("settings.changed"));
        } finally {
            setPending(null);
        }
    }

    async function onDelete() {
        const confirmed = await confirm({
            title: t("settings.deleteTitle"),
            description: t("settings.deleteBody"),
            confirmLabel: t("settings.deleteIt"),
            danger: true
        });
        if (!confirmed) return;
        setPending("delete");
        setError(null);
        try {
            const masterKey = await crypto.deriveMasterKey(current, email, kdf);
            const result = await deleteAccountVaultAction({
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
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("settings.title")}</h1>
                <p className="text-sm text-muted-foreground">
                    {t("settings.intro")}
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.master")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onChangePassword} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("settings.currentMaster")}
                            <Input
                                type="password"
                                autoComplete="current-password"
                                value={current}
                                onChange={(event) => setCurrent(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("settings.newMaster")}
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
                            {t("settings.again")}
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
                            {t("settings.polarisPassword")}
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password
                                The existing account password, typed to prove who this
                                is. Both checks ran when it was chosen; re-running them
                                on a value somebody is confirming would lock them out of
                                their own account over a corpus published since. */}
                            <Input
                                type="password"
                                autoComplete="current-password"
                                value={accountPassword}
                                onChange={(event) => setAccountPassword(event.target.value)}
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("settings.polarisPasswordHint")}
                            </span>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("settings.kdf")}
                            <Select
                                value={nextKdf}
                                onValueChange={setNextKdf}
                                options={kdfOptions}
                                aria-label={t("settings.kdfLabel")}
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("settings.kdfHint")}
                            </span>
                        </label>
                        {done ? <p className="text-sm text-success">{done}</p> : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end">
                            <Button
                                type="submit"
                                disabled={pending !== null || current.length === 0}
                            >
                                {pending === "password" ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : null}
                                {t("settings.changeIt")}
                            </Button>
                        </div>
                    </form>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.icons")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {t("settings.iconsBody")}
                    </p>
                    <label className="flex items-center gap-3 text-sm">
                        <Switch
                            checked={favicons}
                            onChange={(next) => {
                                setFavicons(next);
                                try {
                                    window.localStorage.setItem(FAVICON_KEY, next ? "on" : "off");
                                } catch {
                                    // The list is still drawn; it simply will not
                                    // remember, which is the right thing to lose.
                                }
                            }}
                            aria-label={t("settings.iconsLabel")}
                        />
                        {t("settings.iconsSwitch")}
                    </label>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.apps")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                        {t("settings.appsBody")}
                    </p>
                    <Button
                        variant="secondary"
                        onClick={async () => {
                            await deauthorizeVaultAction();
                            setDone(t("settings.appsSignedOut"));
                        }}
                    >
                        {t("settings.signOutAll")}
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Clock className="size-4" />
                        {t("settings.timeout")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        {t("settings.timeoutBody")}
                    </p>
                    <Select
                        value={lockAfter}
                        onValueChange={async (value) => {
                            setLockAfter(value);
                            setError(null);
                            const result = await setUnlockTimeoutAction(Number(value));
                            if (result.error) {
                                setError(result.error);
                                setLockAfter(String(unlockTimeout));
                                return;
                            }
                            // The session that holds the key was built with the old
                            // setting; locking is the honest way to move to the new
                            // one rather than applying it at some unclear moment.
                            // The reason travels with the lock, because this screen
                            // unmounts the moment the key goes.
                            lock(t("settings.timeoutSaved"));
                        }}
                        aria-label={t("settings.timeoutLabel")}
                        options={core.VAULT_UNLOCK_TIMEOUTS.map((minutes) => ({
                            value: String(minutes),
                            label: unlockTimeoutLabel(t, minutes)
                        }))}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t("settings.timeoutNote")}
                    </p>
                </CardBody>
            </Card>

            <VaultImport vaultKey={vaultKey} />
            <VaultExport vaultKey={vaultKey} confirm={confirm} />

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-danger">
                        <ShieldAlert className="size-4" />
                        {t("settings.deleteVault")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-md text-sm text-muted-foreground">
                        {t("settings.deleteHint")}
                    </p>
                    <Button variant="secondary" onClick={onDelete} disabled={pending !== null}>
                        {pending === "delete" ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Trash2 className="size-4" />
                        )}
                        {t("settings.deleteIt")}
                    </Button>
                </CardBody>
            </Card>
            {confirmDialog}
        </div>
    );
}

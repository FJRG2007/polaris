"use client";

/**
 * The account's sign-in passkeys, each with a switch that lets it unlock this
 * vault.
 *
 * Nothing is created here: the list is the passkeys already on the account,
 * under the names they were given on the security page, and an account with
 * none is sent there to add one. Turning one on runs the PRF ceremony with that
 * credential alone and wraps the key this tab already holds, so it asks for the
 * account's step-up proof rather than the master password - once, and good for
 * two minutes of switches. Turning one off only drops the wrap: the passkey
 * still signs in, and the master password still opens the vault.
 */

import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { useVaultSession } from "../vault-session";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { StepUpDialog } from "@/components/step-up-dialog";
import * as passkeyClient from "@/lib/vault/passkey-client";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { VaultPasskeyChoice } from "@/lib/vault/passkey-schema";
import { stepUpRemainingAction } from "@/app/(app)/account/step-up-actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton, Switch } from "@polaris/ui";
import {
    enrollVaultPasskeyAction,
    removeVaultPasskeyAction,
    vaultPasskeyChoicesAction
} from "../passkey-actions";

/** The step-up purpose these switches are proved under. */
const PURPOSE = "vault-passkeys";

const SECURITY_PATH = "/account/security";

export function VaultPasskeys() {
    const t = useTranslations("vault");
    const format = useDisplayFormat();
    const { key: vaultKey } = useVaultSession();
    const [choices, setChoices] = useState<VaultPasskeyChoice[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [support, setSupport] = useState<passkeyClient.PasskeySupport | null>(null);
    const [host, setHost] = useState("");
    const [proved, setProved] = useState(false);
    const [asking, setAsking] = useState<VaultPasskeyChoice | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoadFailed(false);
        try {
            setChoices(await vaultPasskeyChoicesAction());
        } catch {
            setLoadFailed(true);
        }
    }, []);

    useEffect(() => {
        let live = true;
        setHost(window.location.hostname);
        void load();
        void passkeyClient.passkeySupport().then((value) => live && setSupport(value));
        // A proof given a minute ago on this screen is still good; asking for it
        // again would be asking for nothing.
        void stepUpRemainingAction(PURPOSE)
            .then((result) => live && setProved(result.remainingMs > 0))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [load]);

    const unavailable = support === "no-webauthn" || support === "no-prf";

    function nameOf(choice: VaultPasskeyChoice): string {
        if (choice.name) return choice.name;
        const date = format.date(choice.addedAt);
        return choice.deviceType === "multiDevice"
            ? t("passkeys.synced", { date })
            : t("passkeys.device", { date });
    }

    function failureText(failure: passkeyClient.PasskeyFailure): string {
        if (failure === "cancelled") return t("passkeys.cancelled");
        if (failure === "no-prf") return t("passkeys.noPrfPasskey");
        if (failure === "wrong") return t("passkeys.wrong");
        return t("passkeys.failed");
    }

    async function turnOn(choice: VaultPasskeyChoice) {
        if (!vaultKey) return;
        setPending(choice.passkeyId);
        try {
            const result = await passkeyClient.enrollWithPasskey({
                vaultKey,
                credentialId: choice.credentialId
            });
            if ("failure" in result) {
                setError(failureText(result.failure));
                return;
            }
            const saved = await enrollVaultPasskeyAction(result.enrollment);
            if (saved.needsProof) {
                // The two minutes ran out between the proof and the save.
                setProved(false);
                setError(saved.error ?? null);
                setAsking(choice);
                return;
            }
            if (saved.error) {
                setError(saved.error);
                return;
            }
            setDone(t("passkeys.turnedOn", { name: nameOf(choice) }));
            await load();
        } catch {
            setError(t("passkeys.failed"));
        } finally {
            setPending(null);
        }
    }

    async function turnOff(choice: VaultPasskeyChoice) {
        const vault = choice.vault;
        if (!vault) return;
        const before = choices;
        setChoices(
            (current) =>
                current?.map((entry) =>
                    entry.passkeyId === choice.passkeyId ? { ...entry, vault: null } : entry
                ) ?? null
        );
        setPending(choice.passkeyId);
        try {
            const result = await removeVaultPasskeyAction(vault.id);
            if (result.error) {
                setChoices(before);
                setError(result.error);
                return;
            }
            setDone(t("passkeys.turnedOff", { name: nameOf(choice) }));
        } catch {
            setChoices(before);
            setError(t("passkeys.failed"));
        } finally {
            setPending(null);
        }
    }

    function onToggle(choice: VaultPasskeyChoice, next: boolean) {
        setError(null);
        setDone(null);
        if (!next) {
            void turnOff(choice);
            return;
        }
        if (proved) void turnOn(choice);
        else setAsking(choice);
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <KeyRound className="size-4 shrink-0" />
                    {t("passkeys.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("passkeys.body")}</p>
                {unavailable ? (
                    <p
                        id="vault-passkeys-unavailable"
                        className="text-sm text-muted-foreground"
                        data-testid="passkey-unavailable"
                    >
                        {support === "no-prf"
                            ? t("passkeys.noPrfBrowser")
                            : t("passkeys.noWebAuthn")}
                    </p>
                ) : null}
                {loadFailed ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-danger">{t("passkeys.loadFailed")}</span>
                        <Button variant="secondary" size="sm" onClick={() => void load()}>
                            {t("passkeys.retry")}
                        </Button>
                    </div>
                ) : choices === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        <Skeleton className="h-11 w-full" />
                        <Skeleton className="h-11 w-full" />
                    </div>
                ) : choices.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="passkey-none">
                        {t("passkeys.none")}{" "}
                        <Link href={SECURITY_PATH} className="underline">
                            {t("passkeys.openSecurity")}
                        </Link>
                    </p>
                ) : (
                    <>
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {choices.map((choice) => {
                                const name = nameOf(choice);
                                const elsewhere = host !== "" && choice.rpId !== host;
                                const on = choice.vault !== null;
                                // Off is always allowed; on needs this browser to
                                // reach the credential, which only its own address can.
                                const blocked = !on && (unavailable || elsewhere || !vaultKey);
                                return (
                                    <li
                                        key={choice.passkeyId}
                                        className="flex items-center gap-3 px-3 py-2"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p
                                                className="truncate text-sm font-medium"
                                                title={name}
                                            >
                                                {name}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {!choice.vault ? (
                                                    t("passkeys.off")
                                                ) : choice.vault.lastUsedAt ? (
                                                    <>
                                                        {t("passkeys.lastUsed")}{" "}
                                                        <RelativeTime
                                                            iso={choice.vault.lastUsedAt}
                                                        />
                                                    </>
                                                ) : (
                                                    t("passkeys.neverUsed")
                                                )}
                                                {elsewhere ? (
                                                    <span className="font-mono">
                                                        {" - "}
                                                        {t("passkeys.onlyOn", {
                                                            host: choice.rpId
                                                        })}
                                                    </span>
                                                ) : null}
                                            </p>
                                        </div>
                                        {pending === choice.passkeyId ? (
                                            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                                        ) : null}
                                        <Switch
                                            checked={on}
                                            disabled={pending !== null || blocked}
                                            aria-label={t("passkeys.toggle", { name })}
                                            aria-describedby={
                                                unavailable && !on
                                                    ? "vault-passkeys-unavailable"
                                                    : undefined
                                            }
                                            onChange={(next) => onToggle(choice, next)}
                                        />
                                    </li>
                                );
                            })}
                        </ul>
                        <Link
                            href={SECURITY_PATH}
                            className="self-start text-xs text-muted-foreground underline"
                        >
                            {t("passkeys.manage")}
                        </Link>
                    </>
                )}
                {done ? <p className="text-sm text-success">{done}</p> : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <StepUpDialog
                    open={asking !== null}
                    purpose={PURPOSE}
                    title={t("passkeys.stepUpTitle")}
                    description={t("passkeys.stepUp")}
                    onOpenChange={(open) => !open && setAsking(null)}
                    onProved={() => {
                        setProved(true);
                        const choice = asking;
                        setAsking(null);
                        if (choice) void turnOn(choice);
                    }}
                />
            </CardBody>
        </Card>
    );
}

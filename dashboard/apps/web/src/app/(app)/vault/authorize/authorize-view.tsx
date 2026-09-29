"use client";

/**
 * Deciding on a client that has asked to be let into this vault.
 *
 * Three things are on screen and each is part of the decision: what the app calls
 * itself, where it asked from, and which of this deployment's addresses it asked
 * on. None of them is proof - a label is only ever a label - but a request from an
 * address nobody recognises is exactly what somebody should be able to refuse.
 *
 * The approval happens here rather than on the server because the server cannot do
 * it: the key is sealed to the app's public half with the vault key, and this
 * browser is the only party holding one. What crosses the wire is a ciphertext
 * Polaris cannot open.
 */

import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as vaultCrypto from "@/lib/vault/crypto";
import { useVaultSession } from "../vault-session";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { answerAuthorizationAction, describeAuthorizationAction } from "./actions";
import { formatUserCode, type PendingAuthorization } from "@/lib/vault/authorization-code";

export function AuthorizeView() {
    const t = useTranslations("vault");
    const { key } = useVaultSession();
    const asked = useSearchParams().get("code") ?? "";
    const [typed, setTyped] = useState(asked);
    const [pending, setPending] = useState<PendingAuthorization | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [answered, setAnswered] = useState<"in" | "away" | null>(null);

    const look = async (code: string): Promise<void> => {
        setBusy(true);
        setError("");
        const result = await runAction(() => describeAuthorizationAction(code), setError);
        setBusy(false);
        if (!result || result.error) {
            setPending(null);
            if (result?.error) setError(result.error);
            return;
        }
        setPending(result.pending ?? null);
    };

    // A code that arrived in the address is looked up without being retyped: the
    // app opened this page, and asking somebody to copy what the link already
    // carried is a step that exists for nobody.
    useEffect(() => {
        if (asked.trim() !== "") void look(asked);
        // Only ever on the address it opened with.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [asked]);

    const answer = async (approve: boolean): Promise<void> => {
        if (!pending) return;
        setBusy(true);
        setError("");
        // Sealed here, in the browser that has the vault open. `key` is present
        // because this screen renders inside `VaultGate`, which is what makes
        // approving impossible without an unlock.
        let wrappedKey: string | undefined;
        if (approve) {
            if (!key) {
                setBusy(false);
                setError(t("authorize.errors.unlockFirst"));
                return;
            }
            // The public half is whatever the asking client sent, so sealing to it
            // can fail on a key that is not one. Caught here because the failure is
            // this screen's to report: left to escape, it takes the rejection out of
            // this function and leaves both buttons disabled reading "Working", with
            // nothing said and nothing to do but reload the page.
            try {
                wrappedKey = await vaultCrypto.encryptRsa(
                    vaultCrypto.symmetricKeyBytes(key),
                    pending.publicKey
                );
            } catch {
                setBusy(false);
                setError(t("authorize.errors.unusableKey"));
                return;
            }
        }
        const result = await runAction(
            () => answerAuthorizationAction({ userCode: pending.userCode, approve, wrappedKey }),
            setError
        );
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setPending(null);
        setAnswered(approve ? "in" : "away");
    };

    if (answered) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">
                        {answered === "in" ? t("authorize.letIn") : t("authorize.turnedAway")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {answered === "in" ? t("authorize.letInHint") : t("authorize.turnedAwayHint")}
                    </p>
                </CardBody>
            </Card>
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                {pending ? (
                    <>
                        <div className="flex flex-col gap-1">
                            <p className="text-sm font-medium">{pending.device}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("authorize.code", { code: formatUserCode(pending.userCode) })}
                            </p>
                        </div>
                        <dl className="flex flex-col gap-1 text-xs">
                            <div className="flex justify-between gap-3">
                                <dt className="text-muted-foreground">{t("authorize.askedFrom")}</dt>
                                {/* The whole address, because this is half the
                                    decision and an IPv6 one does not fit the row. */}
                                <dd className="truncate" title={pending.requestIp ?? t("authorize.unknown")}>
                                    {pending.requestIp ?? t("authorize.unknown")}
                                </dd>
                            </div>
                            <div className="flex justify-between gap-3">
                                <dt className="text-muted-foreground">{t("authorize.on")}</dt>
                                {/* And the whole name it was asked on: which of a
                                    deployment's addresses saw the request is the
                                    other half, and the tail is where they differ. */}
                                <dd className="truncate" title={pending.host ?? t("authorize.unknown")}>
                                    {pending.host ?? t("authorize.unknown")}
                                </dd>
                            </div>
                        </dl>
                        <p className="text-xs text-muted-foreground">{t("authorize.warning")}</p>
                        {error ? (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        ) : null}
                        <div className="flex items-center gap-2">
                            <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
                                {busy ? t("authorize.working") : t("authorize.letItIn")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void answer(false)}
                            >
                                {t("authorize.turnItAway")}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <Input
                            autoFocus
                            value={typed}
                            maxLength={16}
                            aria-label={t("authorize.codeLabel")}
                            // i18n-ignore: the shape of the code, not words
                            placeholder="XXXX-XXXX"
                            onChange={(event) => setTyped(event.target.value)}
                            onKeyDown={(event) => event.key === "Enter" && void look(typed)}
                        />
                        {error ? (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        ) : null}
                        <Button
                            size="sm"
                            disabled={busy || typed.trim() === ""}
                            onClick={() => void look(typed)}
                        >
                            {busy ? t("authorize.looking") : t("authorize.findIt")}
                        </Button>
                    </>
                )}
            </CardBody>
        </Card>
    );
}

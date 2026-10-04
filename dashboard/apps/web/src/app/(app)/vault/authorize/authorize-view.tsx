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
import { Blocks, Globe, KeyRound, Network } from "lucide-react";
import { ConsentCard, ConsentCodeEntry, ConsentFacts } from "@/components/consent-card";
import { answerAuthorizationAction, describeAuthorizationAction } from "./actions";
import { formatUserCode, type PendingAuthorization } from "@/lib/vault/authorization-code";

export function AuthorizeView({ account }: { account?: string }) {
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

    const card = { requester: <Blocks className="text-muted-foreground" /> };

    if (answered) {
        return (
            <ConsentCard
                {...card}
                title={answered === "in" ? t("authorize.letIn") : t("authorize.turnedAway")}
                subtitle={
                    answered === "in" ? t("authorize.letInHint") : t("authorize.turnedAwayHint")
                }
            />
        );
    }

    if (!pending) {
        return (
            <ConsentCard {...card} title={t("authorize.codeLabel")} account={account} error={error}>
                <ConsentCodeEntry
                    value={typed}
                    onChange={setTyped}
                    onSubmit={() => void look(typed)}
                    label={t("authorize.codeLabel")}
                    submit={busy ? t("authorize.looking") : t("authorize.findIt")}
                    busy={busy}
                />
            </ConsentCard>
        );
    }

    return (
        <ConsentCard
            {...card}
            title={t("authorize.titleFor", { device: pending.device })}
            subtitle={
                <span className="font-mono">
                    {t("authorize.code", { code: formatUserCode(pending.userCode) })}
                </span>
            }
            account={account}
            error={error}
            deny={{
                label: t("authorize.turnItAway"),
                disabled: busy,
                onClick: () => void answer(false)
            }}
            allow={{
                label: busy ? t("authorize.working") : t("authorize.letItIn"),
                disabled: busy,
                onClick: () => void answer(true)
            }}
        >
            {/* The whole address and the whole name it was asked on: which
                address asked, and which of a deployment's names saw it, are
                the two halves of the decision. Truncated rows keep the full
                value on hover. */}
            <ConsentFacts
                facts={[
                    {
                        icon: <Network />,
                        label: t("authorize.askedFrom"),
                        value: pending.requestIp ?? t("authorize.unknown")
                    },
                    {
                        icon: <Globe />,
                        label: t("authorize.on"),
                        value: pending.host ?? t("authorize.unknown")
                    }
                ]}
            />
            <p className="flex gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-xs text-warning-ink">
                <KeyRound className="size-4 shrink-0" aria-hidden />
                <span>{t("authorize.warning")}</span>
            </p>
        </ConsentCard>
    );
}

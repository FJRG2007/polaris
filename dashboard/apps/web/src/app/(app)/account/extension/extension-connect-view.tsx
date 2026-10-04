"use client";

/**
 * Deciding on a browser extension that has asked to be connected.
 *
 * What is on screen is what the decision rests on: which browser and system the
 * request came from, the address it came from, and which of this deployment's
 * names it arrived on. None of it is proof - a label is only ever a label - but a
 * request from a browser or an address nobody recognises is exactly what somebody
 * should be able to turn away.
 *
 * Saying yes hands the extension a credential for this account and nothing else:
 * no vault is opened by it, and the vault's own approval is still its own screen.
 */

import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useSearchParams } from "next/navigation";
import { formatUserCode } from "@/lib/device-code";
import { Globe, Info, Network, Puzzle } from "lucide-react";
import type { PendingConnection } from "@/lib/extension/sessions";
import { answerConnectionAction, describeConnectionAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BrowserMark, SystemMark } from "@/components/client-marks";
import { ConsentCard, ConsentCodeEntry, ConsentFacts } from "@/components/consent-card";

export function ExtensionConnectView({ account }: { account?: string }) {
    const asked = useSearchParams().get("code") ?? "";
    const t = useTranslations("account");
    const [typed, setTyped] = useState(asked);
    const [pending, setPending] = useState<PendingConnection | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [answered, setAnswered] = useState<"in" | "away" | null>(null);

    const look = async (code: string): Promise<void> => {
        setBusy(true);
        setError("");
        const result = await runAction(() => describeConnectionAction(code), setError);
        setBusy(false);
        if (!result || result.error) {
            setPending(null);
            if (result?.error) setError(result.error);
            return;
        }
        setPending(result.pending ?? null);
    };

    // A code that arrived in the address is looked up without being retyped: the
    // extension opened this page, and asking somebody to copy what the link
    // already carried is a step that exists for nobody.
    useEffect(() => {
        if (asked.trim() !== "") void look(asked);
        // Only ever on the address it opened with.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [asked]);

    const answer = async (approve: boolean): Promise<void> => {
        if (!pending) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => answerConnectionAction({ userCode: pending.userCode, approve }),
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

    const requester = pending ? (
        <BrowserMark browser={pending.browser} />
    ) : (
        <Puzzle className="text-muted-foreground" />
    );

    if (answered) {
        return (
            <ConsentCard
                requester={requester}
                title={answered === "in" ? t("extension.connected") : t("extension.turnedAway")}
                subtitle={
                    answered === "in" ? t("extension.connectedHint") : t("extension.turnedAwayHint")
                }
            />
        );
    }

    if (!pending) {
        return (
            <ConsentCard
                requester={requester}
                title={t("extension.codeLabel")}
                account={account}
                error={error}
            >
                <ConsentCodeEntry
                    value={typed}
                    onChange={setTyped}
                    onSubmit={() => void look(typed)}
                    label={t("extension.codeLabel")}
                    submit={busy ? t("extension.looking") : t("extension.find")}
                    busy={busy}
                />
            </ConsentCard>
        );
    }

    return (
        <ConsentCard
            requester={requester}
            title={t("extension.title", { device: pending.device })}
            subtitle={
                <span className="font-mono">
                    {t("extension.code", { code: formatUserCode(pending.userCode) })}
                </span>
            }
            account={account}
            error={error}
            deny={{
                label: t("extension.turnAway"),
                disabled: busy,
                onClick: () => void answer(false)
            }}
            allow={{
                label: busy ? t("extension.working") : t("extension.connect"),
                disabled: busy,
                onClick: () => void answer(true)
            }}
            footer={
                <>
                    <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {t("extension.consent")}
                </>
            }
        >
            {/* The whole address and the whole name it was asked on: which
                address asked, and which of a deployment's names saw it, are
                the two halves of the decision. Truncated rows keep the full
                value on hover. */}
            <ConsentFacts
                facts={[
                    {
                        icon: <SystemMark os={pending.os} />,
                        label: t("extension.browser"),
                        value: t("extension.browserOn", {
                            browser: pending.browser,
                            os: pending.os
                        })
                    },
                    {
                        icon: <Network />,
                        label: t("extension.askedFrom"),
                        value: pending.requestIp ?? t("extension.unknown")
                    },
                    {
                        icon: <Globe />,
                        label: t("extension.on"),
                        value: pending.host ?? t("extension.unknown")
                    }
                ]}
            />
        </ConsentCard>
    );
}

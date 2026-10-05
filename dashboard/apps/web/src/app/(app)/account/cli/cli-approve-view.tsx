"use client";

/**
 * Deciding on a terminal that has asked to be signed in (`plr login`).
 *
 * What is on screen is what the decision rests on: the computer's name and
 * system, the address the request came from, which of this deployment's names
 * it arrived on, and exactly what the key will be allowed to do. None of it is
 * proof - a name is only a label - but a request from a computer or an address
 * nobody recognises is exactly what somebody should be able to turn away.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { CliScope } from "@/lib/cli/scopes";
import { useSearchParams } from "next/navigation";
import { formatUserCode } from "@/lib/device-code";
import type { PendingCliSignIn } from "@/lib/cli/sign-in";
import { SystemMark } from "@/components/client-marks";
import { Globe, Info, Network, Tag, Terminal } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { answerCliSignInAction, describeCliSignInAction } from "./actions";
import {
    ConsentAbilities,
    ConsentCard,
    ConsentCodeEntry,
    ConsentFacts
} from "@/components/consent-card";

/** The catalog key that says a scope in the reader's words. */
const SCOPE_WORDS: Record<CliScope, "cli.scope.deployRead" | "cli.scope.deployManage"> = {
    "deploy.read": "cli.scope.deployRead",
    "deploy.manage": "cli.scope.deployManage"
};

export function CliApproveView({ account }: { account?: string }) {
    const asked = useSearchParams().get("code") ?? "";
    const t = useTranslations("account");
    const [typed, setTyped] = useState(asked);
    const [pending, setPending] = useState<PendingCliSignIn | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [answered, setAnswered] = useState<"in" | "away" | null>(null);

    const look = async (code: string): Promise<void> => {
        setBusy(true);
        setError("");
        const result = await runAction(() => describeCliSignInAction(code), setError);
        setBusy(false);
        if (!result || result.error) {
            setPending(null);
            if (result?.error) setError(result.error);
            return;
        }
        setPending(result.pending ?? null);
    };

    // The CLI opened this page with its code in the address, so it is looked up
    // without being retyped.
    useEffect(() => {
        if (asked.trim() !== "") void look(asked);
        // Only ever on the address it opened with.
    }, [asked]);

    const answer = async (approve: boolean): Promise<void> => {
        if (!pending) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => answerCliSignInAction({ userCode: pending.userCode, approve }),
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
            <ConsentCard
                requester={<Terminal className="text-muted-foreground" />}
                title={answered === "in" ? t("cli.signedIn") : t("cli.turnedAway")}
                subtitle={
                    answered === "in"
                        ? t.rich("cli.signedInHint", {
                              link: (chunks) => (
                                  <Link key="link" className="underline" href="/account/api-keys">
                                      {chunks}
                                  </Link>
                              )
                          })
                        : t("cli.turnedAwayHint")
                }
            />
        );
    }

    if (!pending) {
        return (
            <ConsentCard
                requester={<Terminal className="text-muted-foreground" />}
                title={t("cli.codeLabel")}
                account={account}
                error={error}
            >
                <ConsentCodeEntry
                    value={typed}
                    onChange={setTyped}
                    onSubmit={() => void look(typed)}
                    label={t("cli.codeLabel")}
                    submit={busy ? t("cli.looking") : t("cli.find")}
                    busy={busy}
                />
            </ConsentCard>
        );
    }

    return (
        <ConsentCard
            requester={<Terminal className="text-muted-foreground" />}
            title={t("cli.title", { device: pending.device })}
            subtitle={
                <span className="font-mono">
                    {t("cli.code", { code: formatUserCode(pending.userCode) })}
                </span>
            }
            account={account}
            error={error}
            deny={{ label: t("cli.deny"), disabled: busy, onClick: () => void answer(false) }}
            allow={{
                label: busy ? t("cli.working") : t("cli.approve"),
                disabled: busy,
                onClick: () => void answer(true)
            }}
            footer={
                <>
                    <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {t("cli.consent")}
                </>
            }
        >
            <ConsentFacts
                facts={[
                    {
                        icon: <SystemMark os={pending.os} />,
                        label: t("cli.system"),
                        value: pending.os
                    },
                    {
                        icon: <Tag />,
                        label: t("cli.version"),
                        value: pending.clientVersion ?? t("cli.unknown")
                    },
                    {
                        icon: <Network />,
                        label: t("cli.askedFrom"),
                        value: pending.requestIp ?? t("cli.unknown")
                    },
                    { icon: <Globe />, label: t("cli.on"), value: pending.host ?? t("cli.unknown") }
                ]}
            />
            <ConsentAbilities
                title={t("cli.asksTo")}
                items={pending.scopes.map((scope) => t(SCOPE_WORDS[scope]))}
            />
        </ConsentCard>
    );
}

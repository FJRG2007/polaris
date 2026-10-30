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

import { useSearchParams } from "next/navigation";
import { formatUserCode } from "@/lib/device-code";
import type { PendingCliSignIn, SignInKind, SignInScope } from "@/lib/cli/sign-in";
import { SystemMark } from "@/components/client-marks";
import { Globe, Grid3x3, Info, Network, Tag, Terminal } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { answerCliSignInAction, describeCliSignInAction } from "./actions";
import {
    ConsentAbilities,
    ConsentCard,
    ConsentCodeEntry,
    ConsentFacts
} from "@/components/consent-card";

/** The catalog key that says a scope in the reader's words. */
const SCOPE_WORDS = {
    "deploy.read": "cli.scope.deployRead",
    "deploy.manage": "cli.scope.deployManage",
    "chat.use": "cli.scope.chatUse",
    "home.read": "cli.scope.homeRead",
    "home.control": "cli.scope.homeControl",
    "home.manage": "cli.scope.homeManage",
    "tasks.read": "cli.scope.tasksRead",
    "tasks.manage": "cli.scope.tasksManage",
    "notes.use": "cli.scope.notesUse",
    "calendar.use": "cli.scope.calendarUse",
    "games.read": "cli.scope.gamesRead",
    "games.moderate": "cli.scope.gamesModerate",
    "games.manage": "cli.scope.gamesManage",
    "agents.read": "cli.scope.agentsRead",
    "agents.manage": "cli.scope.agentsManage"
} as const satisfies Record<SignInScope, `cli.scope.${string}`>;

/**
 * The approval for either client the device grant serves: `plr login`, or the
 * Stream Deck plugin (`kind="streamdeck"`), each in its own words and finding
 * only its own requests.
 */
export function CliApproveView({ account, kind = "cli" }: { account?: string; kind?: SignInKind }) {
    const asked = useSearchParams().get("code") ?? "";
    const t = useTranslations("account");
    const words = kind;
    const Requester = kind === "streamdeck" ? Grid3x3 : Terminal;
    const [typed, setTyped] = useState(asked);
    const [pending, setPending] = useState<PendingCliSignIn | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(asked.trim() !== "");
    const [answered, setAnswered] = useState<"in" | "away" | null>(null);

    const look = async (code: string): Promise<void> => {
        setBusy(true);
        setError("");
        const result = await runAction(() => describeCliSignInAction(code, kind), setError);
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
            () => answerCliSignInAction({ userCode: pending.userCode, approve, kind }),
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
                requester={<Requester className="text-muted-foreground" />}
                title={answered === "in" ? t(`${words}.signedIn`) : t(`${words}.turnedAway`)}
                subtitle={
                    answered === "in"
                        ? t.rich(`${words}.signedInHint`, {
                              link: (chunks) => (
                                  <Link key="link" className="underline" href="/account/api-keys">
                                      {chunks}
                                  </Link>
                              )
                          })
                        : t(`${words}.turnedAwayHint`)
                }
            />
        );
    }

    if (!pending) {
        const checking = busy && typed === asked;
        return (
            <ConsentCard
                requester={<Requester className="text-muted-foreground" />}
                title={checking ? t(`${words}.looking`) : t(`${words}.codeLabel`)}
                account={account}
                error={error}
            >
                <ConsentCodeEntry
                    value={typed}
                    onChange={setTyped}
                    onSubmit={() => void look(typed)}
                    label={t(`${words}.codeLabel`)}
                    submit={busy ? t(`${words}.looking`) : t(`${words}.find`)}
                    busy={busy}
                    checking={checking}
                />
            </ConsentCard>
        );
    }

    return (
        <ConsentCard
            requester={<Requester className="text-muted-foreground" />}
            title={t(`${words}.title`, { device: pending.device })}
            subtitle={
                <span className="font-mono">
                    {t(`${words}.code`, { code: formatUserCode(pending.userCode) })}
                </span>
            }
            account={account}
            error={error}
            deny={{ label: t(`${words}.deny`), disabled: busy, onClick: () => void answer(false) }}
            allow={{
                label: busy ? t(`${words}.working`) : t(`${words}.approve`),
                disabled: busy,
                onClick: () => void answer(true)
            }}
            footer={
                <>
                    <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {t(`${words}.consent`)}
                </>
            }
        >
            <ConsentFacts
                facts={[
                    {
                        icon: <SystemMark os={pending.os} />,
                        label: t(`${words}.system`),
                        value: pending.os
                    },
                    {
                        icon: <Tag />,
                        label: t(`${words}.version`),
                        value: pending.clientVersion ?? t(`${words}.unknown`)
                    },
                    {
                        icon: <Network />,
                        label: t(`${words}.askedFrom`),
                        value: pending.requestIp ?? t(`${words}.unknown`)
                    },
                    {
                        icon: <Globe />,
                        label: t(`${words}.on`),
                        value: pending.host ?? t(`${words}.unknown`)
                    }
                ]}
            />
            <ConsentAbilities
                title={t(`${words}.asksTo`)}
                items={pending.scopes.map((scope) => t(SCOPE_WORDS[scope]))}
            />
        </ConsentCard>
    );
}

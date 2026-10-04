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
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { answerCliSignInAction, describeCliSignInAction } from "./actions";

/** The catalog key that says a scope in the reader's words. */
const SCOPE_WORDS: Record<CliScope, "cli.scope.deployRead" | "cli.scope.deployManage"> = {
    "deploy.read": "cli.scope.deployRead",
    "deploy.manage": "cli.scope.deployManage"
};

export function CliApproveView() {
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">
                        {answered === "in" ? t("cli.signedIn") : t("cli.turnedAway")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {answered === "in"
                            ? t.rich("cli.signedInHint", {
                                  link: (chunks) => (
                                      <Link
                                          key="link"
                                          className="underline"
                                          href="/account/api-keys"
                                      >
                                          {chunks}
                                      </Link>
                                  )
                              })
                            : t("cli.turnedAwayHint")}
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
                        <div className="flex min-w-0 flex-col gap-1">
                            <p className="truncate text-sm font-medium" title={pending.device}>
                                {pending.device}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t("cli.code", { code: formatUserCode(pending.userCode) })}
                            </p>
                        </div>
                        <dl className="flex flex-col gap-1 text-xs">
                            <Row label={t("cli.system")} value={pending.os} />
                            <Row
                                label={t("cli.version")}
                                value={pending.clientVersion ?? t("cli.unknown")}
                            />
                            <Row
                                label={t("cli.askedFrom")}
                                value={pending.requestIp ?? t("cli.unknown")}
                            />
                            <Row label={t("cli.on")} value={pending.host ?? t("cli.unknown")} />
                        </dl>
                        <div className="flex flex-col gap-1">
                            <p className="text-xs font-medium">{t("cli.asksTo")}</p>
                            <ul className="ml-4 list-disc text-xs text-muted-foreground">
                                {pending.scopes.map((scope) => (
                                    <li key={scope}>{t(SCOPE_WORDS[scope])}</li>
                                ))}
                            </ul>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("cli.consent")}</p>
                        {error ? (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
                                {busy ? t("cli.working") : t("cli.approve")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void answer(false)}
                            >
                                {t("cli.deny")}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <Input
                            autoFocus
                            value={typed}
                            maxLength={16}
                            aria-label={t("cli.codeLabel")}
                            // i18n-ignore: the shape of the code
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
                            {busy ? t("cli.looking") : t("cli.find")}
                        </Button>
                    </>
                )}
            </CardBody>
        </Card>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate" title={value}>
                {value}
            </dd>
        </div>
    );
}

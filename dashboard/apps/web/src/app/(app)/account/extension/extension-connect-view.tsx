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
import { Button, Card, CardBody, Input } from "@polaris/ui";
import type { PendingConnection } from "@/lib/extension/sessions";
import { answerConnectionAction, describeConnectionAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function ExtensionConnectView() {
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

    if (answered) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">
                        {answered === "in" ? t("extension.connected") : t("extension.turnedAway")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {answered === "in" ? t("extension.connectedHint") : t("extension.turnedAwayHint")}
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
                                {t("extension.code", { code: formatUserCode(pending.userCode) })}
                            </p>
                        </div>
                        <dl className="flex flex-col gap-1 text-xs">
                            <Row label={t("extension.browser")} value={t("extension.browserOn", { browser: pending.browser, os: pending.os })} />
                            {/* The whole address, because this is half the
                                decision and an IPv6 one does not fit the row. */}
                            <Row label={t("extension.askedFrom")} value={pending.requestIp ?? t("extension.unknown")} />
                            {/* And the whole name it was asked on: which of a
                                deployment's addresses saw the request is the
                                other half, and the tail is where they differ. */}
                            <Row label={t("extension.on")} value={pending.host ?? t("extension.unknown")} />
                        </dl>
                        <p className="text-xs text-muted-foreground">
                            {t("extension.consent")}
                        </p>
                        {error ? (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        ) : null}
                        <div className="flex items-center gap-2">
                            <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
                                {busy ? t("extension.working") : t("extension.connect")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void answer(false)}
                            >
                                {t("extension.turnAway")}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <Input
                            autoFocus
                            value={typed}
                            maxLength={16}
                            aria-label={t("extension.codeLabel")}
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
                            {busy ? t("extension.looking") : t("extension.find")}
                        </Button>
                    </>
                )}
            </CardBody>
        </Card>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate" title={value}>
                {value}
            </dd>
        </div>
    );
}

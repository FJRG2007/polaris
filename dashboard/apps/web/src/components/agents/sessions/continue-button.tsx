"use client";

/**
 * "Continue on phone": a QR that opens this exact session on a phone. While
 * the dialog is open it watches the link, and when a signed-out phone asks to
 * sign in it shows which device is asking and takes the PIN here.
 */

import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { Check, Copy, Smartphone, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { QuickPinInput, pinReady } from "@/components/quick-pin-input";
import { decideQrSignInAction } from "@/app/(app)/account/scan/actions";
import { continueStateAction, openContinueAction, type ContinueState } from "./continue-actions";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

const POLL_MS = 2000;

export function ContinueOnPhoneButton({ sessionId }: { sessionId: string }) {
    const t = useTranslations("agents");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                size="icon"
                variant="ghost"
                aria-label={t("session.continue.button")}
                title={t("session.continue.button")}
                onClick={() => setOpen(true)}
            >
                <Smartphone className="size-4" />
            </Button>
            {open ? <ContinueDialog sessionId={sessionId} onClose={() => setOpen(false)} /> : null}
        </>
    );
}

function ContinueDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const t = useTranslations("agents");
    const [link, setLink] = useState<{ url: string; code: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [state, setState] = useState<ContinueState>({ state: "waiting" });
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [round, setRound] = useState(0);

    useEffect(() => {
        let live = true;
        setLink(null);
        setError(null);
        setState({ state: "waiting" });
        openContinueAction(sessionId)
            .then((opened) => {
                if (!live) return;
                if ("error" in opened) setError(t(`session.continue.errors.${opened.error}`));
                else setLink(opened);
            })
            .catch(() => live && setError(t("session.continue.errors.failed")));
        return () => {
            live = false;
        };
    }, [sessionId, round, t]);

    useEffect(() => {
        if (!link || state.state === "gone") return;
        const timer = setInterval(() => {
            continueStateAction(link.code)
                .then((next) => setState((now) => (now.state === "phone" && next.state === "phone" ? now : next)))
                .catch(() => undefined);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [link, state.state]);

    async function decide(approve: boolean) {
        if (state.state !== "phone") return;
        setBusy(true);
        setError(null);
        const answer = await decideQrSignInAction({ userCode: state.request.userCode, approve, ...(approve ? { pin } : {}) }).catch(() => ({
            error: t("session.continue.errors.failed")
        }));
        setBusy(false);
        setPin("");
        if (answer.error) setError(answer.error);
        else setState({ state: "gone" });
    }

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("session.continue.title")}</DialogTitle>
                    <DialogDescription>{t("session.continue.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-4">
                    {state.state === "phone" ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm">{t("session.continue.phoneAsks")}</p>
                            <dl className="flex flex-col gap-1 text-sm">
                                <div className="flex justify-between gap-3">
                                    <dt className="text-muted-foreground">{t("session.continue.device")}</dt>
                                    <dd className="min-w-0 truncate text-end" title={state.request.device}>
                                        {state.request.device}
                                    </dd>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <dt className="text-muted-foreground">{t("session.continue.from")}</dt>
                                    <dd className="min-w-0 truncate text-end" title={state.request.origin}>
                                        {state.request.origin}
                                    </dd>
                                </div>
                            </dl>
                            {state.hasPin ? (
                                <form
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        if (pinReady(pin, state.pinLength)) void decide(true);
                                    }}
                                >
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("session.continue.pin")}
                                        <QuickPinInput length={state.pinLength} value={pin} readOnly={busy} onValueChange={setPin} />
                                    </label>
                                </form>
                            ) : (
                                <p className="text-sm text-muted-foreground">{t("session.continue.needsPin")}</p>
                            )}
                            <div className="flex justify-end gap-2">
                                <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                                    <X className="size-4" />
                                    {t("session.continue.refuse")}
                                </Button>
                                <Button disabled={busy || !state.hasPin || !pinReady(pin, state.pinLength)} onClick={() => void decide(true)}>
                                    <Check className="size-4" />
                                    {t("session.continue.allow")}
                                </Button>
                            </div>
                        </div>
                    ) : state.state === "gone" ? (
                        <div className="flex flex-col items-start gap-3">
                            <p className="text-sm text-muted-foreground">{t("session.continue.gone")}</p>
                            <Button variant="outline" onClick={() => setRound((at) => at + 1)}>
                                {t("session.continue.again")}
                            </Button>
                        </div>
                    ) : link ? (
                        <div className="flex flex-col items-center gap-3">
                            <div className="rounded-lg bg-white p-3">
                                <QRCodeSVG value={link.url} size={176} bgColor="#ffffff" fgColor="#000000" />
                            </div>
                            <p className="text-center text-xs text-muted-foreground">{t("session.continue.expires")}</p>
                            <Button
                                variant="outline"
                                className="max-w-full"
                                onClick={() => {
                                    void navigator.clipboard
                                        .writeText(link.url)
                                        .then(() => setCopied(true))
                                        .catch(() => setError(t("session.continue.errors.copy")));
                                }}
                            >
                                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                <span className="min-w-0 truncate">{copied ? t("session.continue.copied") : t("session.continue.copy")}</span>
                            </Button>
                        </div>
                    ) : error ? null : (
                        <div className="mx-auto size-[200px] animate-pulse rounded-lg bg-muted" aria-hidden />
                    )}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

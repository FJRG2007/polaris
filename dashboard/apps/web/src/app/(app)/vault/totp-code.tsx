"use client";

/**
 * The six digits beside a login, and how long they have left.
 *
 * Recomputed once a second so the countdown is honest - a code that says 12
 * seconds when it has 2 is worse than no countdown - and the whole calculation
 * happens here, from a secret that was decrypted in this tab.
 */

import { QRCodeSVG } from "qrcode.react";
import { Button, CopyButton } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as core from "@/lib/vault/totp-browser";
import { otpauthUri, totpCode, totpKey, totpRemaining } from "@/lib/vault/totp-browser";

/**
 * The seconds left, as a ring that empties.
 *
 * A number counting down says the same thing, and says it worse: the question
 * somebody has while looking at a six-digit code is "do I have time to type
 * this", which is a shape rather than an arithmetic. The ring is read at a
 * glance, and the colour walks green to amber to red as the answer changes from
 * yes to hurry to wait for the next one.
 *
 * Drawn as an SVG circle with a dashed outline rather than as a spinning border,
 * so it is one element, it degrades to a number for anybody who cannot see it,
 * and it does not animate for its own sake - it moves once a second because
 * that is when the fact changes.
 */
function CountdownRing({ remaining, of }: { remaining: number; of: number }) {
    const t = useTranslations("vault");
    const period = Math.max(1, of);
    const left = Math.max(0, Math.min(period, remaining));
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const tone =
        left <= 5 ? "text-danger" : left <= Math.max(8, period / 3) ? "text-warning" : "text-success";

    return (
        <span
            className={`relative flex size-7 shrink-0 items-center justify-center ${tone}`}
            role="timer"
            aria-label={t("totp.secondsLeft", { count: left })}
        >
            <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90">
                <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    strokeWidth="2.5"
                    className="stroke-border"
                />
                <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    stroke="currentColor"
                    // The remaining arc. `strokeDashoffset` walks the dash round
                    // the circle, which is one property changing once a second
                    // rather than a redraw.
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - left / period)}
                    className="transition-[stroke-dashoffset] duration-1000 ease-linear"
                />
            </svg>
            <span className="text-[0.625rem] font-medium tabular-nums">{left}</span>
        </span>
    );
}

/**
 * The key itself, to add the same login to an authenticator app: the QR code
 * a phone scans and the secret for typing by hand. Hidden until asked for -
 * it is the second factor, and anybody who sees it holds it.
 */
function TotpKeyPanel({
    value,
    issuer,
    account
}: {
    value: string;
    issuer: string;
    account: string;
}) {
    const t = useTranslations("vault");
    const key = totpKey(value);
    const uri = otpauthUri(value, { issuer, account });
    if (!key || !uri) return null;
    return (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
            {/* Fixed light colours: a QR has to stay readable in dark mode. */}
            <div className="shrink-0 rounded-md bg-white p-2">
                <QRCodeSVG value={uri} size={132} bgColor="#ffffff" fgColor="#000000" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("totp.keyLabel")}</span>
                <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 break-all font-mono text-sm">{key}</code>
                    <CopyButton
                        value={key.replace(/ /g, "")}
                        label={t("totp.keyLabel")}
                        className="shrink-0"
                    />
                </div>
                <span className="text-xs text-muted-foreground">{t("totp.keyHint")}</span>
            </div>
        </div>
    );
}

export function TotpCode({
    value,
    issuer = "",
    account = ""
}: {
    value: string;
    /** The site and the account, which name the key in an authenticator app. */
    issuer?: string;
    account?: string;
}) {
    const [code, setCode] = useState<string | null>(null);
    const [showKey, setShowKey] = useState(false);
    const [remaining, setRemaining] = useState(30);
    const t = useTranslations("vault");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let live = true;
        const tick = async () => {
            const next = await totpCode(value);
            if (!live) return;
            setCode(next);
            setRemaining(totpRemaining(value));
        };
        void tick();
        const timer = setInterval(tick, 1000);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [value]);

    if (!code) {
        return (
            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t("totp.label")}</span>
                <p className="text-sm text-muted-foreground">{t("totp.unreadable")}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <span className="text-xs text-muted-foreground">{t("totp.label")}</span>
                    <p className="font-mono text-sm tracking-widest">
                        {code.slice(0, 3)} {code.slice(3)}
                    </p>
                </div>
                <CountdownRing remaining={remaining} of={core.parseTotp(value)?.period ?? 30} />
                <Button
                    size="icon"
                    variant="ghost"
                    title={t("totp.copy")}
                    aria-label={t("totp.copyLabel")}
                    onClick={async () => {
                        await navigator.clipboard.writeText(code);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                    }}
                >
                    {copied ? (
                        <Check className="size-4 text-success" />
                    ) : (
                        <Copy className="size-4" />
                    )}
                </Button>
                <Button
                    size="icon"
                    variant="ghost"
                    title={showKey ? t("totp.hideKey") : t("totp.showKey")}
                    aria-label={showKey ? t("totp.hideKey") : t("totp.showKey")}
                    aria-pressed={showKey}
                    onClick={() => setShowKey((shown) => !shown)}
                >
                    <KeyRound className="size-4 shrink-0" />
                </Button>
            </div>
            {showKey ? <TotpKeyPanel value={value} issuer={issuer} account={account} /> : null}
        </div>
    );
}

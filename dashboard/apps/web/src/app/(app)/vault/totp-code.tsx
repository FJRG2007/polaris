"use client";

/**
 * The six digits beside a login, and how long they have left.
 *
 * Recomputed once a second so the countdown is honest - a code that says 12
 * seconds when it has 2 is worse than no countdown - and the whole calculation
 * happens here, from a secret that was decrypted in this tab.
 */

import { Button } from "@polaris/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import * as core from "@/lib/vault/totp-browser";
import { totpCode, totpRemaining } from "@/lib/vault/totp-browser";

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
            aria-label={`${left} seconds left`}
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

export function TotpCode({ value }: { value: string }) {
    const [code, setCode] = useState<string | null>(null);
    const [remaining, setRemaining] = useState(30);
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
                <span className="text-xs text-muted-foreground">Authenticator</span>
                <p className="text-sm text-muted-foreground">That key is not one this can read.</p>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
                <span className="text-xs text-muted-foreground">Authenticator</span>
                <p className="font-mono text-sm tracking-widest">
                    {code.slice(0, 3)} {code.slice(3)}
                </p>
            </div>
            <CountdownRing remaining={remaining} of={core.parseTotp(value)?.period ?? 30} />
            <Button
                size="icon"
                variant="ghost"
                title="Copy the code"
                aria-label="Copy the authenticator code"
                onClick={async () => {
                    await navigator.clipboard.writeText(code);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                }}
            >
                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
        </div>
    );
}

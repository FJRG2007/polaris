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
import { totpCode, totpRemaining } from "@/lib/vault/totp-browser";

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
            <span
                className={`text-xs tabular-nums ${remaining <= 5 ? "text-danger" : "text-muted-foreground"}`}
                aria-label={`${remaining} seconds left`}
            >
                {remaining}s
            </span>
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

"use client";

/**
 * Copy one value to the clipboard, with the check-mark acknowledgement.
 *
 * Everything the domains panels ask an operator to copy is a value they then type
 * somewhere Polaris cannot reach - a registrar's DNS form, a router's port-forward
 * form - so a check mark shown for a copy that did not happen is worse than no
 * check mark at all: they paste whatever was in the clipboard before. Hence the
 * acknowledgement waits for the write, and a refused one leaves the icon alone.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@polaris/ui";

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);

    async function copy(): Promise<void> {
        // Absent on an insecure origin, and refused when the document is not
        // focused or permission is denied. Either way there is nothing to confirm.
        if (!navigator.clipboard) return;
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            return;
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
    }

    return (
        <button
            type="button"
            aria-label={`Copy ${label ?? value}`}
            title="Copy"
            className={cn("text-muted-foreground transition-colors hover:text-foreground", className)}
            onClick={() => void copy()}
        >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
    );
}

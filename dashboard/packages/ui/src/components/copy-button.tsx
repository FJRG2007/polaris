"use client";

/**
 * Copy one value to the clipboard, with the check-mark acknowledgement.
 *
 * A check mark shown for a copy that did not happen is worse than no check mark
 * at all: whoever trusts it pastes whatever was in the clipboard before - the
 * DNS record that never reached the registrar's form, the command that never
 * reached the terminal. Hence the acknowledgement waits for the write, and a
 * refused one leaves the icon alone.
 */

import { cn } from "../lib/cn";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStrings } from "../lib/ui-strings";

/** How long the check mark stays: long enough to be seen, short enough that a
 *  second copy still shows one. */
const COPIED_MS = 1500;

/**
 * The acknowledgement on its own, for a copy control drawn somewhere else - a
 * message action, a code block. `copied` turns true only once the clipboard has
 * the value, and back after `COPIED_MS`.
 */
export function useCopied(): { copied: boolean; copy: (value: string) => Promise<boolean> } {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );

    const copy = useCallback(async (value: string): Promise<boolean> => {
        // Absent on an insecure origin, and refused when the document is not
        // focused or permission is denied. Either way there is nothing to confirm.
        if (!navigator.clipboard) return false;
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            return false;
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        return true;
    }, []);

    return { copied, copy };
}

/** The copy icon, swapped for the check mark while `copied`. */
export function CopyIcon({ copied, className }: { copied: boolean; className?: string }) {
    return copied ? (
        <Check className={cn("size-3.5 text-success-ink", className)} />
    ) : (
        <Copy className={cn("size-3.5", className)} />
    );
}

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
    const words = useUiStrings();
    const { copied, copy } = useCopied();

    return (
        <button
            type="button"
            aria-label={words.copyNamed(label ?? value)}
            title={words.copy}
            className={cn("text-muted-foreground transition-colors hover:text-foreground", className)}
            onClick={() => void copy(value)}
        >
            <CopyIcon copied={copied} />
        </button>
    );
}

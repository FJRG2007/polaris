"use client";

/**
 * A switch that moves under the finger and only moves back if the server refuses.
 *
 * Waiting for the round trip before showing the new position made every switch feel
 * broken for half a second, and disabling it meanwhile made a second press land on
 * nothing. Here the value on screen is the reader's intent at once; the saves run one
 * at a time, always of the latest intent, so flipping it on-off-on quickly sends at
 * most two requests and never lets an older answer overwrite a newer press. A refusal
 * puts back what the server last confirmed and says so in a toast.
 */

import { useToast } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The refusal an action answered with, or null when it went through. Actions here
 *  answer `{ error }`, `{ ok: false }`, or throw; anything else is success. */
export function refusalOf(result: unknown): { message: string | null } | null {
    if (result === null || typeof result !== "object") return null;
    const { error, ok } = result as { error?: unknown; ok?: unknown };
    if (typeof error === "string" && error.length > 0) return { message: error };
    if (error !== undefined && error !== null && error !== false) return { message: null };
    if (ok === false) return { message: null };
    return null;
}

export interface OptimisticToggleOptions {
    /** What the toast says when the server refuses without saying why. */
    readonly failure?: string;
    /** Told once the server holds a new value, e.g. to update a list the switch is in. */
    readonly onSaved?: (value: boolean) => void;
    /** Told on a refusal, after the switch is back. Replaces the toast when given. */
    readonly onRefused?: (message: string) => void;
}

/**
 * `[value, toggle, pending]` for a switch whose server holds `serverValue` and whose
 * `action(next)` saves a new one. `toggle()` flips; `toggle(next)` sets. `pending` is
 * for a quiet "saving" hint, never for disabling the switch.
 */
export function useOptimisticToggle(
    serverValue: boolean,
    action: (next: boolean) => Promise<unknown>,
    options: OptimisticToggleOptions = {}
): readonly [boolean, (next?: boolean) => void, boolean] {
    const t = useTranslations("common");
    const toast = useToast();
    const [held, setHeld] = useState(serverValue);
    const [wanted, setWanted] = useState<boolean | null>(null);
    const [pending, setPending] = useState(false);

    // The same facts outside React, so the save loop reads the latest press without
    // waiting for a render, and so a press during a save rides on the next one.
    const confirmed = useRef(serverValue);
    const intent = useRef<boolean | null>(null);
    const sending = useRef(false);
    const latest = useRef({ action, options, t, toast });
    latest.current = { action, options, t, toast };

    // The server's value can change under the switch (a refetch, another tab). Taken
    // as the truth whenever nothing is in flight; mid-save the save's answer wins.
    useEffect(() => {
        if (sending.current) return;
        confirmed.current = serverValue;
        setHeld(serverValue);
    }, [serverValue]);

    const flush = useCallback(async () => {
        if (sending.current) return;
        sending.current = true;
        setPending(true);
        try {
            while (intent.current !== null && intent.current !== confirmed.current) {
                const sent = intent.current;
                const result = await latest.current.action(sent).catch(() => ({ error: true }));
                const refused = refusalOf(result);
                if (refused) {
                    intent.current = null;
                    setWanted(null);
                    setHeld(confirmed.current);
                    const { options: now, t: say, toast: notes } = latest.current;
                    const message = refused.message ?? now.failure ?? say("optimistic.failed");
                    if (now.onRefused) now.onRefused(message);
                    else notes.show({ title: message });
                    return;
                }
                confirmed.current = sent;
                setHeld(sent);
                latest.current.options.onSaved?.(sent);
            }
            intent.current = null;
            setWanted(null);
        } finally {
            sending.current = false;
            setPending(false);
        }
    }, []);

    const value = wanted ?? held;
    const toggle = useCallback(
        (next?: boolean) => {
            const target = next ?? !(intent.current ?? confirmed.current);
            intent.current = target;
            setWanted(target);
            void flush();
        },
        [flush]
    );

    return [value, toggle, pending] as const;
}

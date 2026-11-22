"use client";

/**
 * Sending a one-time code from a step that needs one: sent by itself the moment
 * the step opens on a method that delivers, once, then a resend that waits out
 * `TWO_FACTOR_RESEND_SECONDS` before it can be pressed again.
 *
 * "Once" has to survive more than a re-render. The send time is written to this
 * tab's session storage before the request leaves, so React's doubled effects in
 * development, a back-and-forward to the page, or a reload inside the wait all
 * find it and show the countdown instead of asking for a second code - which,
 * arriving after the first, would leave the person typing a code that no longer
 * works. The server refuses inside the wait as well (`gateTwoFactorSend`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { TWO_FACTOR_RESEND_SECONDS } from "@/lib/two-factor-resend";

/** What one send came back with. */
export interface SendOutcome {
    error?: string;
    /** The server's own wait, when it refused because a code just went out. */
    retryAfterSeconds?: number;
}

const STORAGE_PREFIX = "polaris.code-sent.";

function readSentAt(key: string): number | null {
    try {
        const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
        const at = raw ? Number(raw) : NaN;
        return Number.isFinite(at) ? at : null;
    } catch {
        return null;
    }
}

function writeSentAt(key: string, at: number | null): void {
    try {
        if (at === null) window.sessionStorage.removeItem(STORAGE_PREFIX + key);
        else window.sessionStorage.setItem(STORAGE_PREFIX + key, String(at));
    } catch {
        // Storage refused (private mode): the in-memory guard still holds.
    }
}

/** Seconds left of the wait that started at `at`, never negative. */
export function secondsLeft(at: number, now: number, wait = TWO_FACTOR_RESEND_SECONDS): number {
    return Math.max(0, Math.ceil((at + wait * 1000 - now) / 1000));
}

export function useCodeSending({
    scope,
    auto,
    send
}: {
    /** What the code is for and by which method, e.g. "sign-in:telegram".
     *  Null when the current step sends nothing (an authenticator, a backup
     *  code), which leaves the hook idle. */
    scope: string | null;
    /** Send on entry. False where the step still needs something typed first. */
    auto: boolean;
    send: () => Promise<SendOutcome>;
}) {
    const [sent, setSent] = useState(false);
    const [sending, setSending] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const fired = useRef(new Set<string>());
    const sendRef = useRef(send);
    sendRef.current = send;

    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
        return () => clearTimeout(timer);
    }, [cooldown]);

    const fire = useCallback(async (key: string) => {
        fired.current.add(key);
        writeSentAt(key, Date.now());
        setSending(true);
        setError(null);
        const outcome = await sendRef.current().catch(() => ({ error: "" }) as SendOutcome);
        setSending(false);
        if (outcome.retryAfterSeconds) {
            // A code is already on its way: the wait is the server's, and the
            // code the person holds is still the one that works.
            setSent(true);
            setCooldown(outcome.retryAfterSeconds);
            writeSentAt(key, Date.now() - (TWO_FACTOR_RESEND_SECONDS - outcome.retryAfterSeconds) * 1000);
            return;
        }
        if (outcome.error !== undefined) {
            writeSentAt(key, null);
            setError(outcome.error);
            return;
        }
        setSent(true);
        setCooldown(TWO_FACTOR_RESEND_SECONDS);
    }, []);

    useEffect(() => {
        setSent(false);
        setError(null);
        setCooldown(0);
        if (!scope) return;
        const at = readSentAt(scope);
        const left = at === null ? 0 : secondsLeft(at, Date.now());
        if (left > 0) {
            setSent(true);
            setCooldown(left);
            return;
        }
        if (auto && !fired.current.has(scope)) void fire(scope);
    }, [scope, auto, fire]);

    const resend = useCallback(() => {
        if (scope && cooldown <= 0 && !sending) void fire(scope);
    }, [scope, cooldown, sending, fire]);

    return { sent, sending, cooldown, error, resend };
}

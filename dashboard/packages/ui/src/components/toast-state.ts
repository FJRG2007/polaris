"use client";

/**
 * What a note is doing - being held, answered, acted on - and when it goes.
 *
 * Shared by every way a note is drawn, so the plain note and the message note
 * keep exactly the same rules: hover and an answer in progress hold it, its time
 * runs only while somebody can see the tab, and it says "Sent" before it goes.
 */

import { useUiStrings } from "../lib/ui-strings";
import type { ToastAction, Toast } from "./toast";
import { useEffect, useRef, useState } from "react";

/** How long one stays when it is not being hovered. */
const LIFE_MS = 6000;

/** How long a note that sent an answer says so before it goes. */
const SENT_MS = 1500;

/** A note as the stack holds it. */
export interface Shown extends Toast {
    readonly id: string;
    /** Which showing this is: a note replaced under the same key is a new one. */
    readonly shownAs: number;
}

/** Whether somebody can see this tab: the browser draws it. Not whether it
 *  has the keyboard - a window on a second screen is read without being clicked. */
function seenNow(): boolean {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible";
}

/** Whether the tab is being looked at, kept current. */
function useSeen(): boolean {
    const [seen, setSeen] = useState(seenNow);
    useEffect(() => {
        const update = () => setSeen(seenNow());
        update();
        document.addEventListener("visibilitychange", update);
        return () => document.removeEventListener("visibilitychange", update);
    }, []);
    return seen;
}

export function useNoteState(toast: Shown, onDismiss: () => void) {
    const words = useUiStrings();
    const [held, setHeld] = useState(false);
    /** The answer being written on it: null while nobody has asked to. */
    const [answer, setAnswer] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    /** The action under way, by label. */
    const [acting, setActing] = useState<string | null>(null);
    /** The action whose choices are open on the note, by label. */
    const [choosing, setChoosing] = useState<ToastAction | null>(null);
    const seen = useSeen();
    const life = toast.life ?? LIFE_MS;
    // Writing an answer holds the note like a pointer over it does: it must not
    // go in the middle of a sentence.
    const writing = answer !== null || sending || acting !== null || choosing !== null;
    // A note replaced while it said "Sent" is about something new, which has not
    // been answered; an answer half written or on its way is kept.
    const showing = useRef(toast.shownAs);
    showing.current = toast.shownAs;
    useEffect(() => setSent(false), [toast.shownAs]);

    useEffect(() => {
        if (!sent) return;
        const timer = setTimeout(onDismiss, SENT_MS);
        return () => clearTimeout(timer);
    }, [sent, onDismiss]);

    const send = async () => {
        const text = (answer ?? "").trim();
        if (!toast.reply || text.length === 0 || sending) return;
        setSending(true);
        setProblem(null);
        const sentFrom = showing.current;
        const refused = await toast.reply.send(text).catch(() => words.couldNotSend);
        setSending(false);
        if (refused) {
            setProblem(refused);
            return;
        }
        setAnswer(null);
        if (showing.current === sentFrom) setSent(true);
    };

    const act = async (action: { label: string; run?: () => Promise<string | null> }) => {
        if (acting || !action.run) return;
        const actedFrom = showing.current;
        setActing(action.label);
        setProblem(null);
        const refused = await action.run().catch(() => words.didNotWork);
        setActing(null);
        if (showing.current !== actedFrom) return;
        if (refused) setProblem(refused);
        else onDismiss();
    };

    useEffect(() => {
        if (held || writing || sent || !seen || life <= 0) return;
        const timer = setTimeout(onDismiss, life);
        return () => clearTimeout(timer);
        // Re-armed when the pointer leaves, which is what "hover holds it" is,
        // and when somebody comes back to the tab, which is when they can read it.
    }, [held, writing, sent, seen, life, onDismiss, toast.shownAs]);

    return {
        words,
        setHeld,
        answer,
        setAnswer,
        sending,
        sent,
        problem,
        setProblem,
        acting,
        choosing,
        setChoosing,
        send,
        act
    };
}

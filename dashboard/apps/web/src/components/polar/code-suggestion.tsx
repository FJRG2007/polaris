"use client";

/**
 * The suggested next message in a Code thread's composer, the way Chat shows
 * its own (`polar-panel.tsx`) and Claude Code shows prompt suggestions: greyed
 * in the empty box once a turn has ended, Tab (or a tap on a touch screen)
 * puts it in the box to edit, typing or Escape dismisses it, and it is never
 * sent by itself. Asked for once per turn, only for an answer that arrived
 * while this tab was open - a session only opened costs nothing - and never
 * while the turn runs, so neither the turn nor the page waits on it (`lib/polar/code-suggestion.ts`).
 */

import { Button } from "@polaris/ui";
import type { PolarCodeThread } from "@/lib/polar/code";
import { codeSuggestionTurn } from "@/lib/polar/code-suggestion";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { usePolarDisplay } from "@/components/polar/polar-display";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

interface Options {
    sessionId: string;
    thread: PolarCodeThread | null | undefined;
    /** What is in the box now; anything typed hides the suggestion. */
    value: string;
    /** Puts the suggestion in the box. */
    onAccept: (text: string) => void;
    /** The box, focused with the cursor at the end once a suggestion is taken. */
    inputId: string;
    /** False while a voice call or anything else owns the box. */
    enabled?: boolean;
}

export interface CodeSuggestion {
    /** The suggestion to show, or null. */
    ghost: string | null;
    /** The placeholder the box shows: the suggestion, else `fallback`. */
    placeholder: (fallback: string) => string;
    /** Wraps the box's own key handler: Tab takes, Escape dismisses. */
    onKeyDown: (
        next?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
    ) => (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    /** What goes above the box: the screen-reader line and the touch chip. */
    beforeInput: ReactNode;
    describedBy: string | undefined;
}

export function useCodeSuggestion({
    sessionId,
    thread,
    value,
    onAccept,
    inputId,
    enabled = true
}: Options): CodeSuggestion {
    const t = useTranslations("polar");
    const display = usePolarDisplay();
    const on = enabled && display.codeSuggestions;
    const [suggested, setSuggested] = useState<{ key: string; text: string } | null>(null);
    const asked = useRef(new Set<string>());
    // The turn the session showed when it was opened here: an answer that was
    // already there gets no suggestion, only one that arrives while watched.
    const opened = useRef<{ sessionId: string; key: string | null } | null>(null);
    const session = thread?.session;
    const turn = useMemo(
        () =>
            thread && session
                ? codeSuggestionTurn(thread.entries, session, thread.permission !== null)
                : null,
        [thread, session]
    );
    const key = turn ? `${sessionId}:${turn.answerId}` : null;
    const lastAnswer = thread
        ? [...thread.entries].reverse().find(
              (entry) => entry.type === "message" && entry.role === "agent" && entry.text.trim()
          )
        : undefined;
    if (thread && opened.current?.sessionId !== sessionId) {
        opened.current = { sessionId, key: lastAnswer ? `${sessionId}:${lastAnswer.id}` : null };
    }

    useEffect(() => {
        if (!on || !turn || !key || opened.current?.key === key) return;
        if (asked.current.has(key)) return;
        asked.current.add(key);
        const params = new URLSearchParams({ sessionId, after: turn.answerId });
        fetch(`/api/polar/code/suggestion?${params}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { suggestion?: unknown } | null) => {
                const text = typeof data?.suggestion === "string" ? data.suggestion.trim() : "";
                if (text) setSuggested({ key, text });
            })
            .catch(() => undefined);
    }, [on, key, sessionId]);

    // Typing dismisses it for good, as in Chat: clearing the box again does
    // not bring it back.
    useEffect(() => {
        if (value) setSuggested(null);
    }, [value]);

    const ghost = on && suggested && suggested.key === key && !value ? suggested.text : null;
    const describedId = `${inputId}-suggestion`;

    const accept = (text: string) => {
        setSuggested(null);
        onAccept(text);
        requestAnimationFrame(() => {
            const box = document.getElementById(inputId);
            if (!(box instanceof HTMLTextAreaElement)) return;
            box.focus();
            box.setSelectionRange(text.length, text.length);
        });
    };

    return {
        ghost,
        placeholder: (fallback) => ghost ?? fallback,
        onKeyDown: (next) => (event) => {
            if (ghost && !event.nativeEvent.isComposing) {
                if (event.key === "Tab" && !event.shiftKey) {
                    event.preventDefault();
                    accept(ghost);
                    return;
                }
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setSuggested(null);
                    return;
                }
            }
            next?.(event);
        },
        describedBy: ghost ? describedId : undefined,
        beforeInput: ghost ? (
            <>
                <span id={describedId} className="sr-only">
                    {t("composer.suggestion.described", { text: ghost })}
                </span>
                {/* No Tab key on a touch screen: the suggestion is a tap. */}
                <div className="hidden min-w-0 px-3 pt-2 [@media(pointer:coarse)]:flex">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11 max-w-full"
                        aria-label={t("composer.suggestion.use", { text: ghost })}
                        onClick={() => accept(ghost)}
                    >
                        <span className="truncate" title={ghost}>
                            {ghost}
                        </span>
                    </Button>
                </div>
            </>
        ) : null
    };
}

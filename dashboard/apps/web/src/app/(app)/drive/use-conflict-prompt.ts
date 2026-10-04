"use client";

/**
 * The name-clash dialog as something code can await: `ask` opens it and
 * resolves with the person's answers, or null for Cancel. Questions are asked
 * one after another - two moves that both run into a late clash get the dialog
 * in turn, never one answer meant for the other.
 */

import { useCallback, useRef, useState } from "react";
import type { ConflictRequest } from "./conflict-dialog";
import type { ConflictChoice } from "@/lib/drive/conflict-types";

export type ConflictAnswers = Map<string, ConflictChoice> | null;

export function useConflictPrompt() {
    const [request, setRequest] = useState<ConflictRequest | null>(null);
    const answer = useRef<((decisions: ConflictAnswers) => void) | null>(null);
    const queue = useRef<Promise<unknown>>(Promise.resolve());

    const ask = useCallback((next: ConflictRequest): Promise<ConflictAnswers> => {
        const asked = queue.current.then(
            () =>
                new Promise<ConflictAnswers>((resolve) => {
                    answer.current = resolve;
                    setRequest(next);
                })
        );
        queue.current = asked.catch(() => undefined);
        return asked;
    }, []);

    const respond = useCallback((decisions: ConflictAnswers) => {
        const resolve = answer.current;
        answer.current = null;
        setRequest(null);
        resolve?.(decisions);
    }, []);

    return { request, ask, respond };
}

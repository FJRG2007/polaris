/**
 * The browser half of `poll-route`: one timed read, asked through its route.
 *
 * Rejects when the read could not be had - a failed request, a refusal, an
 * abort - the way the server action it replaces rejected, so a caller's existing
 * failure handling keeps working unchanged.
 */

import { z } from "zod";
import { useCallback, useEffect, useRef } from "react";
import { fromWire } from "@/lib/app-bundles/wire";

const answerSchema = z.object({ value: z.unknown() });

export async function readPoll<T>(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal
): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const response = await fetch(search ? `${path}?${search}` : path, {
        cache: "no-store",
        signal
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    const parsed = answerSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`${path} answered something unreadable`);
    return fromWire(parsed.data.value) as T;
}

/**
 * A signal that aborts when the component unmounts, read at the moment of each
 * ask so a remount (Strict Mode's included) gets a fresh one.
 */
export function useUnmountSignal(): () => AbortSignal | undefined {
    const controller = useRef<AbortController | null>(null);
    useEffect(() => {
        controller.current = new AbortController();
        return () => controller.current?.abort();
    }, []);
    return useCallback(() => controller.current?.signal, []);
}

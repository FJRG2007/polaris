"use client";

/**
 * "Listen along" under somebody's track, and "Stop listening" once pressed.
 *
 * Who this account is following is one answer shared by every card on the
 * screen, asked once and kept for a short while (`FRESH_MS`), so a member list
 * full of people listening to music is one request rather than one per card.
 *
 * Every refusal is a sentence from the server - no Premium, no Spotify open, no
 * account linked - shown under the button, with the way to fix it where there
 * is one here.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { Headphones, Loader2, Square } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

const PATH = "/api/activity/listen-along";

/** How long the answer is trusted before a card asks again. */
const FRESH_MS = 30_000;

interface Held {
    hostId: string | null;
    at: number;
    asking: Promise<void> | null;
}

const held: Held = { hostId: null, at: 0, asking: null };
const listeners = new Set<() => void>();

function publish(hostId: string | null): void {
    held.hostId = hostId;
    held.at = Date.now();
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function refresh(): void {
    if (held.asking || Date.now() - held.at < FRESH_MS) return;
    held.asking = fetch(PATH, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { hostId?: unknown } | null) => {
            if (body) publish(typeof body.hostId === "string" ? body.hostId : null);
        })
        .catch(() => undefined)
        .finally(() => {
            held.asking = null;
        });
}

export function ListenAlongButton({ hostId }: { hostId: string }) {
    const following = useSyncExternalStore(
        subscribe,
        () => held.hostId,
        () => null
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ text: string; link: boolean } | null>(null);

    useEffect(refresh, []);

    const mine = following === hostId;

    const press = async () => {
        setBusy(true);
        setError(null);
        const before = held.hostId;
        // Drawn at once, and put back if Spotify says no.
        publish(mine ? null : hostId);
        try {
            const response = await fetch(PATH, {
                method: mine ? "DELETE" : "POST",
                headers: { "content-type": "application/json" },
                body: mine ? undefined : JSON.stringify({ hostId })
            });
            const body = (await response.json().catch(() => null)) as {
                error?: unknown;
                kind?: unknown;
            } | null;
            if (!response.ok) {
                publish(before);
                setError({
                    text: typeof body?.error === "string" ? body.error : "That did not work. Try again.",
                    link: body?.kind === "link"
                });
            }
        } catch {
            publish(before);
            setError({ text: "Polaris could not be reached. Try again.", link: false });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex w-full flex-col gap-1">
            <Button
                size="sm"
                variant={mine ? "secondary" : "primary"}
                onClick={() => void press()}
                disabled={busy}
                className="w-full"
                title={mine ? "Stop following their music" : "Play this on your own Spotify, in step with them"}
            >
                {busy ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : mine ? (
                    <Square className="size-3.5 shrink-0" />
                ) : (
                    <Headphones className="size-4 shrink-0" />
                )}
                {mine ? "Stop listening along" : "Listen along"}
            </Button>
            {error ? (
                <p role="alert" className="text-[0.6875rem] leading-snug text-danger">
                    {error.text}{" "}
                    {error.link ? (
                        <Link href="/account/connections" className="underline underline-offset-2">
                            Connected accounts
                        </Link>
                    ) : null}
                </p>
            ) : null}
        </div>
    );
}

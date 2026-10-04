"use client";

/**
 * Whether a player in a message starts with its sound on, per site.
 *
 * Pressing play on a video in a conversation is asking to watch it, and a video
 * watched in silence is half of one - so a player starts with its sound on. But
 * somebody who mutes TikTok once has said what they want from TikTok, and the
 * next one starts muted; unmuting one says the opposite, and that is remembered
 * too. Per site, keyed by the player's host, because the answer for one site is
 * not the answer for another.
 *
 * Per browser, like the call volumes and the covers: it is a fact about the room
 * a screen is in. The desktop app is this same page, so it keeps its own answer
 * the same way.
 *
 * A player says it is muted the moment it loads - TikTok's always starts that
 * way - before it has been told anything. That is not the reader's choice, so
 * nothing is remembered until the player has done what it was asked once
 * (`soundStep`).
 */

import { z } from "zod";

const KEY = "polaris.chat.embed-muted";

/** Hosts the reader has decided about, and which way. */
const storedSchema = z.record(z.string().min(1).max(253), z.boolean());

type Stored = z.infer<typeof storedSchema>;

/** What a stored value holds, or nothing chosen when it does not parse. */
export function parseEmbedMuted(raw: string | null): Stored {
    if (raw === null) return {};
    try {
        const parsed = storedSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** Whether a player from `host` starts muted. Off for a site nobody has muted:
 *  play was pressed to watch it. */
export function embedMuted(host: string): boolean {
    return parseEmbedMuted(read())[host] === true;
}

export function setEmbedMuted(host: string, muted: boolean): void {
    const next = { ...parseEmbedMuted(read()), [host]: muted };
    try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // It still applies to this player; it just will not be remembered.
    }
}

function read(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(KEY);
    } catch {
        // Storage refused - a browser with it disabled. Sound on, as for a
        // site nobody has decided about.
        return null;
    }
}

/** How many times one player is told how to sound before it is left alone, so a
 *  player that keeps refusing is not asked forever. */
const MAX_ASKS = 2;

/** Where one player is: whether it has done what it was told, and how often it
 *  has been told. */
export interface SoundState {
    readonly settled: boolean;
    readonly asks: number;
}

export const SOUND_START: SoundState = { settled: false, asks: 0 };

/**
 * What to do with one thing a player said: tell it how to sound (`ask`), and
 * remember the reader's choice (`remember`, null for nothing to remember).
 *
 * Until the player is settled, a mute report that is not what is wanted is the
 * player's own default and gets an ask; one that is, settles it. Starting to
 * play unsettled is asked once more, for a player that never reported. Once
 * settled, every report is the reader pressing the player's volume button.
 */
export function soundStep(
    state: SoundState,
    wanted: boolean,
    event: { muted: boolean } | "playing"
): { state: SoundState; ask: boolean; remember: boolean | null } {
    if (state.settled) {
        return { state, ask: false, remember: event === "playing" ? null : event.muted };
    }
    if (event !== "playing" && event.muted === wanted) {
        return { state: { ...state, settled: true }, ask: false, remember: null };
    }
    if (state.asks >= MAX_ASKS) return { state, ask: false, remember: null };
    return { state: { ...state, asks: state.asks + 1 }, ask: true, remember: null };
}

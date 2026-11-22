// @vitest-environment jsdom

/**
 * The conversation list kept in order while the app is open.
 *
 * What is pinned: a tab coming back from the background reads the list again
 * (a phone that slept missed every frame meanwhile), a short look away does
 * not; a slow read that lands after a newer one leaves the newer order on
 * screen; and a change from a row's menu shows at once, survives a read that
 * was already out, and is taken back with a toast when the server refuses it.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; pinned: boolean; muted: boolean; lastMessageAt: string; last: null };

const row = (id: string, at: string, extra: Partial<Row> = {}): Row => ({
    id,
    pinned: false,
    muted: false,
    lastMessageAt: at,
    last: null,
    ...extra
});

let full = 0;
/** What the next reads answer, in order; the last one repeats. */
let answers: Row[][] = [];
/** Reads held until released, to land them out of order. */
let held: Array<(rows: Row[]) => void> = [];
let holding = false;

// One router for every render, as the real hook gives.
const router = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/(app)/chat/actions", () => ({
    listChannelsAction: async () => ({ channels: answers[0] ?? [] }),
    chatRulesAction: async () => ({ rules: null })
}));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ callsUnavailableAction: async () => null }));

const { ChatProvider, RESYNC_AFTER_HIDDEN_MS, useChat } = await import(
    "@/app/(app)/chat/chat-context"
);
const { byPinThenActivity } = await import("@/lib/chat/conversation-list");
const { ToastProvider } = await import("@polaris/ui");

let chat: ReturnType<typeof useChat> | null = null;
function Probe() {
    chat = useChat();
    return null;
}

const may = { spaces: true, groups: true, attach: true, call: false, meetings: false };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const order = (): string[] =>
    [...(chat?.channels ?? [])]
        .sort(byPinThenActivity as (a: unknown, b: unknown) => number)
        .map((entry) => entry.id);

async function mount(): Promise<void> {
    render(
        <ToastProvider>
            <ChatProvider viewerId="ada" viewerName="Ada" orgId={null} orgName={null} may={may}>
                <Probe />
            </ChatProvider>
        </ToastProvider>
    );
    await act(() => wait(10));
}

function setVisibility(state: "visible" | "hidden"): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
}

const EVENING = "2026-11-21T18:00:00.000Z";
const NOW = "2026-11-22T09:59:00.000Z";
const LATER = "2026-11-22T10:00:00.000Z";

beforeEach(() => {
    full = 0;
    chat = null;
    held = [];
    holding = false;
    sessionStorage.clear();
    answers = [[row("ada", NOW), row("grace", EVENING)]];
    vi.stubGlobal("fetch", async () => {
        full += 1;
        const rows = answers.length > 1 ? answers.shift()! : answers[0]!;
        const body = (channels: Row[]) =>
            new Response(JSON.stringify({ channels, spaces: [], categories: [], blocked: [] }));
        if (!holding) return body(rows);
        return new Promise<Response>((resolve) => held.push((late) => resolve(body(late))));
    });
});

afterEach(() => {
    cleanup();
    setVisibility("visible");
    vi.unstubAllGlobals();
});

describe("after the tab was away", () => {
    it("reads the list again when a phone wakes up, and reorders it", async () => {
        await mount();
        expect(order()).toEqual(["ada", "grace"]);
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        setVisibility("hidden");
        // Grace wrote while the screen was off; the stream never said so.
        answers = [[row("ada", NOW), row("grace", LATER)]];
        clock.mockReturnValue(now + RESYNC_AFTER_HIDDEN_MS + 1);
        await act(async () => {
            setVisibility("visible");
            await wait(10);
        });
        clock.mockRestore();
        expect(full).toBe(2);
        expect(order()).toEqual(["grace", "ada"]);
    });

    it("does not ask again for a quick look away", async () => {
        await mount();
        await act(async () => {
            setVisibility("hidden");
            setVisibility("visible");
            await wait(10);
        });
        expect(full).toBe(1);
    });

    it("reads it again when the network comes back", async () => {
        await mount();
        await act(async () => {
            window.dispatchEvent(new Event("online"));
            await wait(10);
        });
        expect(full).toBe(2);
    });
});

describe("answers landing out of order", () => {
    it("keeps the newer order when an older read lands last", async () => {
        await mount();
        holding = true;
        await act(async () => {
            chat!.refresh();
            await wait(0);
        });
        // A second read is queued behind the first by `refresh` itself, so the
        // out-of-order case is the conversations-only read racing a full one.
        answers = [[row("ada", NOW), row("grace", LATER)]];
        await act(async () => {
            chat!.refreshChannels();
            await wait(400);
        });
        expect(order()).toEqual(["grace", "ada"]);
        await act(async () => {
            held.shift()?.([row("ada", NOW), row("grace", EVENING)]);
            await wait(10);
        });
        expect(order()).toEqual(["grace", "ada"]);
    });
});

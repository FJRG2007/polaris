// @vitest-environment jsdom

/**
 * Polar in the side panel when Polaris does not answer: the copy of a
 * conversation the embed hands over (only from its frame, on its origin, in its
 * shape), how much of it is kept, the read-only view drawn from it, and the
 * retry that hands back to the live chat as soon as Polaris answers.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as offline from "../src/lib/polar-offline";
import { OfflineView } from "../src/entrypoints/sidepanel/offline";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const SERVER = "https://polaris.example.test";
const frame = {};

const conversation = (id: string, text = "hello"): offline.KeptConversation => ({
    id,
    title: text,
    at: 1000,
    messages: [
        { role: "user", text },
        { role: "assistant", text: "Here:\n```ts\nconst a = 1;\n```\nDone." }
    ]
});

const sent = (overrides: Record<string, unknown> = {}) => ({
    data: {
        source: "polaris-embed",
        kind: "snapshot",
        account: "user-1",
        conversation: conversation("t1"),
        ...overrides
    },
    origin: SERVER,
    source: frame
});

describe("snapshotFrom", () => {
    it("takes the embed's snapshot from its frame on its origin", () => {
        expect(offline.snapshotFrom(sent(), frame, SERVER)).toEqual({
            account: "user-1",
            conversation: conversation("t1")
        });
    });

    it("refuses another sender, another origin, or another shape", () => {
        expect(offline.snapshotFrom({ ...sent(), source: {} }, frame, SERVER)).toBeNull();
        expect(
            offline.snapshotFrom({ ...sent(), origin: "https://evil.example.test" }, frame, SERVER)
        ).toBeNull();
        expect(
            offline.snapshotFrom(sent({ source: "polaris-extension" }), frame, SERVER)
        ).toBeNull();
        expect(offline.snapshotFrom(sent({ account: "" }), frame, SERVER)).toBeNull();
        const long = {
            ...conversation("t1"),
            messages: [{ role: "user", text: "x".repeat(8001) }]
        };
        expect(offline.snapshotFrom(sent({ conversation: long }), frame, SERVER)).toBeNull();
        const many = {
            ...conversation("t1"),
            messages: Array.from({ length: 41 }, () => ({ role: "user", text: "a" }))
        };
        expect(offline.snapshotFrom(sent({ conversation: many }), frame, SERVER)).toBeNull();
        const role = { ...conversation("t1"), messages: [{ role: "system", text: "a" }] };
        expect(offline.snapshotFrom(sent({ conversation: role }), frame, SERVER)).toBeNull();
    });
});

describe("remember", () => {
    it("keeps the newest first, once each, at most ten", () => {
        let kept: offline.Kept | null = null;
        for (let at = 0; at < 14; at += 1)
            kept = offline.remember(kept, "u", conversation(`t${at}`));
        kept = offline.remember(kept, "u", conversation("t5", "again"));
        expect(kept.conversations).toHaveLength(offline.KEPT_CONVERSATIONS);
        expect(kept.conversations[0]).toMatchObject({ id: "t5", title: "again" });
        expect(kept.conversations.filter((one) => one.id === "t5")).toHaveLength(1);
    });

    it("stays under the storage budget", () => {
        let kept: offline.Kept | null = null;
        const big = "y".repeat(7900);
        for (let at = 0; at < 10; at += 1) {
            kept = offline.remember(kept, "u", {
                ...conversation(`t${at}`),
                messages: Array.from({ length: 40 }, () => ({ role: "user" as const, text: big }))
            });
        }
        expect(new TextEncoder().encode(JSON.stringify(kept)).length).toBeLessThanOrEqual(
            offline.KEPT_BYTES
        );
        expect(kept!.conversations[0]?.id).toBe("t9");
    });

    it("never mixes in another account's chats", () => {
        const first = offline.remember(null, "a", conversation("t1"));
        expect(
            offline.remember(first, "b", conversation("t2")).conversations.map((c) => c.id)
        ).toEqual(["t2"]);
    });

    it("reads a stored copy total, dropping what is malformed", () => {
        expect(offline.readKept(null)).toBeNull();
        expect(
            offline.readKept({ account: "u", conversations: [conversation("t1"), { id: 3 }] })
        ).toEqual({ account: "u", conversations: [conversation("t1")] });
    });
});

describe("retryDelay and blocksOf", () => {
    it("waits longer each time, up to a minute", () => {
        expect([0, 1, 2, 3, 4, 9].map(offline.retryDelay)).toEqual([
            5000, 10_000, 20_000, 40_000, 60_000, 60_000
        ]);
    });

    it("cuts fenced code out of the text", () => {
        expect(offline.blocksOf("Here:\n```ts\nconst a = 1;\n```\nDone.")).toEqual([
            { kind: "text", text: "Here:" },
            { kind: "code", text: "const a = 1;" },
            { kind: "text", text: "Done." }
        ]);
    });
});

describe("the offline view", () => {
    const view = (props: Partial<Parameters<typeof OfflineView>[0]> = {}) =>
        render(
            <OfflineView
                kept={{
                    account: "u",
                    conversations: [conversation("t1", "First chat"), conversation("t2", "Second")]
                }}
                since={new Date(2026, 9, 23, 17, 5).getTime()}
                draft=""
                onDraft={() => {}}
                probe={async () => false}
                onBack={() => {}}
                {...props}
            />
        );

    it("draws the kept chat read-only, with since when and a retry", () => {
        view();
        expect(screen.getByRole("status").textContent).toContain("Polaris has not answered since");
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
        expect(screen.getByText("First chat", { selector: "p" })).toBeTruthy();
        expect(screen.getByText("const a = 1;").closest("pre")).toBeTruthy();
        expect(screen.getAllByRole("button", { name: /First chat|Second/ })).toHaveLength(2);
        expect(screen.getByRole("textbox")).toBeTruthy();
    });

    it("says when there is no copy yet", () => {
        view({ kept: null });
        expect(screen.getByText("No chat has been copied here yet.")).toBeTruthy();
    });

    it("keeps trying on its own and swaps back the moment Polaris answers", async () => {
        vi.useFakeTimers();
        const answers = [false, true];
        const probe = vi.fn(async () => answers.shift() ?? true);
        const onBack = vi.fn();
        view({ probe, onBack });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(probe).toHaveBeenCalledTimes(2);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("keeps what is typed as a draft, and sends nothing", async () => {
        const onDraft = vi.fn();
        const probe = vi.fn(async () => false);
        view({ onDraft, probe, draft: "half a question" });
        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("half a question");
        expect(probe).not.toHaveBeenCalled();
    });
});

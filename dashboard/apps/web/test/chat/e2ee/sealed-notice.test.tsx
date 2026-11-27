// @vitest-environment jsdom

/**
 * The "end-to-end encrypted" line at the start of a conversation and the lock
 * beside its name. Pinned here: they show only where sends really are sealed
 * (`sealsSendsIn`), never while sealed chat is off, never while the answer is
 * unknown or could not be had, and the line opens the explainer - with the
 * safety number in a one-to-one, and the group sentence otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const sealed = vi.hoisted(() => ({
    active: true,
    answer: true as boolean | Error,
    asked: [] as string[]
}));

vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealedChatActive: () => sealed.active,
    publicUnsealed: async () => false,
    sealsSendsIn: async (channelId: string) => {
        sealed.asked.push(channelId);
        if (sealed.answer instanceof Error) throw sealed.answer;
        return sealed.answer;
    }
}));
vi.mock("@/components/i18n/i18n-provider", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/app/(app)/chat/safety-number", () => ({
    SafetyNumberView: ({ peerName }: { peerName: string }) => <p>safety number of {peerName}</p>
}));

const { SealedMark, SealedNotice } = await import("@/app/(app)/chat/sealed-notice");

/** Lets the `sealsSendsIn` answer land. */
async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    sealed.active = true;
    sealed.answer = true;
    sealed.asked = [];
});

afterEach(cleanup);

describe("SealedNotice", () => {
    it("says the conversation is sealed once sends there are sealed", async () => {
        render(<SealedNotice channelId="c1" peer={null} />);
        await settle();
        expect(screen.getByText("sealedNotice.line")).toBeTruthy();
        expect(sealed.asked).toEqual(["c1"]);
    });

    it("shows nothing while sealed chat is off, and does not ask", async () => {
        sealed.active = false;
        const { container } = render(<SealedNotice channelId="c1" peer={null} />);
        await settle();
        expect(container.textContent).toBe("");
        expect(sealed.asked).toEqual([]);
    });

    it("shows nothing in a conversation that still sends in the clear (held)", async () => {
        sealed.answer = false;
        const { container } = render(<SealedNotice channelId="c1" peer={null} />);
        await settle();
        expect(container.textContent).toBe("");
    });

    it("shows nothing when it cannot be told", async () => {
        sealed.answer = new Error("device unavailable");
        const { container } = render(<SealedNotice channelId="c1" peer={null} />);
        await settle();
        expect(container.textContent).toBe("");
    });

    it("does not carry one conversation's answer to the next", async () => {
        const { container, rerender } = render(<SealedNotice channelId="c1" peer={null} />);
        await settle();
        expect(container.textContent).toContain("sealedNotice.line");
        sealed.answer = false;
        rerender(<SealedNotice channelId="c2" peer={null} />);
        expect(container.textContent).toBe("");
        await settle();
        expect(container.textContent).toBe("");
    });

    it("opens the explainer with the safety number in a one-to-one", async () => {
        render(<SealedNotice channelId="c1" peer={{ id: "u2", name: "Ana" }} />);
        await settle();
        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByText("sealedNotice.body")).toBeTruthy();
        expect(screen.getByText("safety number of Ana")).toBeTruthy();
        expect(screen.queryByText("sealedNotice.groupVerify")).toBeNull();
    });

    it("opens the explainer without a number in a group", async () => {
        render(<SealedNotice channelId="c1" peer={null} />);
        await settle();
        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByText("sealedNotice.groupVerify")).toBeTruthy();
        expect(screen.queryByText(/safety number of/)).toBeNull();
    });
});

describe("SealedMark", () => {
    it("draws the lock only in a sealed conversation", async () => {
        const { container, rerender } = render(<SealedMark channelId="c1" peer={null} />);
        await settle();
        expect(screen.getByRole("button", { name: "sealedNotice.mark" })).toBeTruthy();
        sealed.answer = false;
        rerender(<SealedMark channelId="c2" peer={null} />);
        await settle();
        expect(container.innerHTML).toBe("");
    });
});

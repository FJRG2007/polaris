// @vitest-environment jsdom

/**
 * Disappearing messages on screen: a message leaves at its expiry, "also delete
 * for" follows the rules the server handed back, and a proposal is answered only
 * by the people it waits on.
 */

import { MessagesWrapper } from "../../setup/i18n";
import type { DirectRulesView } from "@/lib/chat/vanish";
import type { ChatMessageView } from "@/lib/chat/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

vi.mock("@/app/(app)/chat/vanish-actions", () => ({
    directRulesAction: vi.fn(),
    hideMessageAction: vi.fn()
}));

const { DeleteChatDialog, ProposalBar, durationName, nextExpiry, useDropExpired, withoutExpired } = await import(
    "@/app/(app)/chat/vanish-controls"
);

afterEach(cleanup);

const NOW = Date.parse("2026-11-16T12:00:00Z");

function message(id: string, expiresAt?: string): ChatMessageView {
    return { id, createdAt: "2026-11-16T11:00:00Z", ...(expiresAt ? { expiresAt } : {}) } as ChatMessageView;
}

function rules(overrides: Partial<DirectRulesView> = {}): DirectRulesView {
    return {
        mode: "open",
        kind: "dm",
        vanishAfter: 0,
        deleteForAll: true,
        receipts: "follow",
        typing: "follow",
        agreed: false,
        mayChange: true,
        proposes: false,
        proposal: null,
        ...overrides
    };
}

describe("expiry on screen", () => {
    it("drops what is past its expiry and keeps the rest", () => {
        const list = [
            message("kept"),
            message("gone", "2026-11-16T11:59:59Z"),
            message("later", "2026-11-16T13:00:00Z")
        ];
        expect(withoutExpired(list, NOW).map((one) => one.id)).toEqual(["kept", "later"]);
    });
    it("hands back the same list when nothing has gone, so nothing redraws", () => {
        const list = [message("kept"), message("later", "2026-11-16T13:00:00Z")];
        expect(withoutExpired(list, NOW)).toBe(list);
    });
    it("waits for the soonest expiry still ahead", () => {
        const list = [
            message("a", "2026-11-16T14:00:00Z"),
            message("b", "2026-11-16T13:00:00Z"),
            message("c")
        ];
        expect(nextExpiry(list, NOW)).toBe(Date.parse("2026-11-16T13:00:00Z"));
        expect(nextExpiry([message("c")], NOW)).toBeNull();
    });
    it("names every offered timer", () => {
        expect([0, 86_400, 604_800, 2_592_000, 7_776_000].map(durationName)).toEqual([
            "off",
            "day",
            "week",
            "month",
            "quarter"
        ]);
    });
});

describe("a list that drops what expires", () => {
    afterEach(() => vi.useRealTimers());
    it("takes a message out at its expiry, without a reload", () => {
        vi.useFakeTimers({ now: NOW });
        const { result } = renderHook(() => {
            const [list, setList] = useState<readonly ChatMessageView[] | null>([
                message("kept"),
                message("soon", "2026-11-16T12:00:05Z")
            ]);
            useDropExpired(list, setList);
            return list;
        });
        expect(result.current?.map((one) => one.id)).toEqual(["kept", "soon"]);
        act(() => vi.advanceTimersByTime(5_000));
        expect(result.current?.map((one) => one.id)).toEqual(["kept"]);
    });
});

function deleteDialog(current: DirectRulesView, onDelete = vi.fn(async () => null)) {
    render(
        <MessagesWrapper>
            <DeleteChatDialog
                open
                onOpenChange={() => undefined}
                name="Grace"
                rules={current}
                onDelete={onDelete}
            />
        </MessagesWrapper>
    );
    return onDelete;
}

describe("deleting the chat", () => {
    it("deletes for me only unless the box is ticked", async () => {
        const onDelete = deleteDialog(rules());
        fireEvent.click(screen.getByRole("button", { name: "Delete for me" }));
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(false));
    });
    it("deletes for both once the box is ticked, where the rules allow it", async () => {
        const onDelete = deleteDialog(rules());
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByRole("button", { name: "Delete for everyone" }));
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(true));
    });
    it("draws the box refused, with the reason, where they do not", () => {
        deleteDialog(rules({ mode: "agreement", deleteForAll: false }));
        expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
        expect(screen.getByText("Not allowed until everyone in the chat agrees to it")).toBeTruthy();
    });
    it("stays open with the refusal", async () => {
        deleteDialog(rules(), vi.fn(async () => "Deleting this chat for everyone is not allowed here"));
        fireEvent.click(screen.getByRole("button", { name: "Delete for me" }));
        expect(await screen.findByText("Deleting this chat for everyone is not allowed here")).toBeTruthy();
    });
});

describe("a proposal", () => {
    const proposal = {
        id: "p1",
        proposedById: "grace",
        vanishAfter: 604_800,
        deleteForAll: true,
        receipts: "follow" as const,
        typing: "follow" as const,
        mayAnswer: true,
        mine: false
    };
    function bar(current: DirectRulesView, onAnswer = vi.fn(async () => undefined)) {
        render(
            <MessagesWrapper>
                <ProposalBar rules={current} proposerName="Grace" onAnswer={onAnswer} />
            </MessagesWrapper>
        );
        return onAnswer;
    }

    it("is answered by the people it waits on", async () => {
        const onAnswer = bar(rules({ mode: "agreement", proposal }));
        expect(screen.getByText("Grace proposed a change")).toBeTruthy();
        expect(screen.getByText("Disappearing messages: 7 days")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Accept" }));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("p1", true));
    });
    it("only waits, for the one who proposed it", () => {
        bar(rules({ mode: "agreement", proposal: { ...proposal, mayAnswer: false, mine: true } }));
        expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
        expect(screen.getByText("Waiting for the others to accept your proposal")).toBeTruthy();
    });
    it("may be withdrawn by the one who proposed it", async () => {
        const onWithdraw = vi.fn(async () => undefined);
        render(
            <MessagesWrapper>
                <ProposalBar
                    rules={rules({ mode: "agreement", proposal: { ...proposal, mayAnswer: false, mine: true } })}
                    proposerName="Ada"
                    onAnswer={vi.fn(async () => undefined)}
                    onWithdraw={onWithdraw}
                />
            </MessagesWrapper>
        );
        fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
        await waitFor(() => expect(onWithdraw).toHaveBeenCalledWith("p1"));
    });
    it("is nothing without one", () => {
        bar(rules({ mode: "agreement" }));
        expect(screen.queryByRole("status")).toBeNull();
    });
});

const { ChatPrivacySection } = await import("@/app/(app)/chat/chat-privacy-section");

describe("the conversation's privacy section", () => {
    function section(current: DirectRulesView) {
        render(
            <MessagesWrapper>
                <ChatPrivacySection
                    rules={current}
                    proposerName="Grace"
                    onChange={vi.fn()}
                    onAnswer={vi.fn(async () => undefined)}
                    onWithdraw={vi.fn(async () => undefined)}
                />
            </MessagesWrapper>
        );
    }

    it("shows a group member the values and the reason, with nothing to change", () => {
        section(rules({ kind: "group", mayChange: false, receipts: "on" }));
        expect(screen.getByText("Only the group's owner and admins can change these.")).toBeTruthy();
        expect(screen.getByText("On")).toBeTruthy();
        expect(screen.getAllByText("Follows each person's settings")).toHaveLength(1);
        expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("offers the controls, and says a change is proposed in the agreement mode", () => {
        section(rules({ mode: "agreement", proposes: true }));
        expect(screen.getByText("Changes are proposed and apply once accepted.")).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Read receipts" })).toBeTruthy();
    });
});

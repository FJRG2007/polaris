// @vitest-environment jsdom

/**
 * A face in a list while its owner is writing: the presence dot stretches into a
 * pill of three dots in the same colour, the way Discord's lists show it.
 */

import { Avatar } from "@/components/avatar";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const presence = vi.hoisted(() => ({ value: { status: "idle", inCall: false } as unknown }));

vi.mock("@/components/presence-store", () => ({
    usePresence: (id: string | null) => (id ? presence.value : null)
}));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const PERSON = { id: "018f2b7a-0000-7000-8000-00000000000b", name: "Grace Hopper" };

afterEach(() => {
    cleanup();
    presence.value = { status: "idle", inCall: false };
});

describe("the typing pill", () => {
    it("takes the dot's place, in the dot's colour", () => {
        render(<Avatar person={PERSON} size={40} typing />, { wrapper: MessagesWrapper });
        const pill = screen.getByRole("img", { name: "Typing" });
        expect(pill.className).toContain("bg-warning");
        expect(pill.className).toContain("typing-dots");
        expect(pill.children).toHaveLength(3);
        expect(screen.queryByLabelText("Idle")).toBeNull();
    });

    it("is the plain dot again once they stop", () => {
        const { rerender } = render(<Avatar person={PERSON} size={40} typing />, {
            wrapper: MessagesWrapper
        });
        rerender(<Avatar person={PERSON} size={40} typing={false} />);
        expect(screen.queryByRole("img", { name: "Typing" })).toBeNull();
    });

    it("replaces the call badge rather than sitting beside it", () => {
        presence.value = { status: "busy", inCall: "call-1" };
        render(<Avatar person={PERSON} size={40} typing />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("img", { name: "Typing" }).className).toContain("bg-success");
        expect(screen.queryByLabelText("On a call you can join")).toBeNull();
    });

    it("does not wait for the presence store", () => {
        presence.value = null;
        render(<Avatar person={PERSON} size={40} typing />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("img", { name: "Typing" }).className).toContain("bg-success");
    });

    it("is not drawn where no dot would be", () => {
        render(<Avatar person={PERSON} size={16} typing />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("img", { name: "Typing" })).toBeNull();
        cleanup();
        render(<Avatar person={PERSON} size={40} status={false} typing />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("img", { name: "Typing" })).toBeNull();
        cleanup();
        render(<Avatar person={PERSON} size={40} callBadge={null} typing />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("img", { name: "Typing" })).toBeNull();
    });
});

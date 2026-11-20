// @vitest-environment jsdom

/**
 * The composer's "+" on a phone: one button, the way Discord and WhatsApp do
 * it, opening a sheet with Camera, Photos, Files and Poll - instead of a row of
 * small icons beside the box. A computer keeps the icons.
 */

import { MessagesWrapper } from "../setup/i18n";
import { DEFAULT_CHAT_RULES } from "@polaris/core";
import { Composer } from "@/app/(app)/chat/composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function screenWidth(phone: boolean) {
    vi.stubGlobal(
        "matchMedia",
        (media: string) =>
            ({
                matches: phone && media === "(max-width: 639px)",
                media,
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            }) as unknown as MediaQueryList
    );
}

function chatBox(poll = true) {
    return render(
        <Composer
            channelId="c1"
            rules={DEFAULT_CHAT_RULES}
            disabled={false}
            placeholder="Message"
            onSend={() => undefined}
            onPoll={poll ? async () => ({}) : undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

describe("adding to a message on a phone", () => {
    it("is one + that opens Camera, Photos, Files and Poll", () => {
        screenWidth(true);
        chatBox();
        expect(screen.queryByRole("button", { name: "Attach a file" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Create a poll" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
        for (const name of ["Camera", "Photos", "Files", "Poll"]) {
            expect(screen.getByRole("button", { name })).toBeTruthy();
        }
    });

    it("opens the poll from the sheet", () => {
        screenWidth(true);
        chatBox();
        fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
        fireEvent.click(screen.getByRole("button", { name: "Poll" }));
        expect(screen.queryByRole("button", { name: "Camera" })).toBeNull();
        expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("leaves Poll out where a poll has nowhere to go", () => {
        screenWidth(true);
        chatBox(false);
        fireEvent.click(screen.getByRole("button", { name: "Add to the message" }));
        expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Poll" })).toBeNull();
    });

    it("keeps the icons on a computer", () => {
        screenWidth(false);
        chatBox();
        expect(screen.queryByRole("button", { name: "Add to the message" })).toBeNull();
        expect(screen.getByRole("button", { name: "Attach a file" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Create a poll" })).toBeTruthy();
    });
});

// @vitest-environment jsdom
/**
 * Voice mode by transcription says so: without live voice on offer it names
 * the mode as slower and links to where a provider is connected; with live
 * voice on offer (the person switched away from it) it offers the way back.
 * Also the answer a live call reads back from a finished Polar reply.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { TranscribedNotice } = await import("@/components/polar/polar-voice");
const { spokenAnswer } = await import("@/components/polar/live-voice-call");

afterEach(() => cleanup());

describe("TranscribedNotice", () => {
    it("says the mode is slower and links to the providers", () => {
        render(<TranscribedNotice live={false} onLive={() => undefined} />, { wrapper: MessagesWrapper });
        expect(screen.getByText(/Voice by transcription: slower/)).toBeTruthy();
        const link = screen.getByRole("link", { name: "Connect a provider" });
        expect(link.getAttribute("href")).toBe("/polar/settings/providers");
    });
    it("offers live voice back when it is on offer", () => {
        const onLive = vi.fn();
        render(<TranscribedNotice live onLive={onLive} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Switch to live voice" }));
        expect(onLive).toHaveBeenCalledOnce();
    });
});

describe("spokenAnswer", () => {
    it("reads the text of an assistant reply without markup", () => {
        expect(
            spokenAnswer({
                id: "a",
                role: "assistant",
                parts: [{ type: "text", text: "**Done.** The task `Call Ana` is made." }]
            })
        ).toBe("Done. The task Call Ana is made.");
    });
    it("has nothing for a user message or a reply that is only code", () => {
        expect(spokenAnswer({ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] })).toBeNull();
        expect(spokenAnswer({ id: "a", role: "assistant", parts: [{ type: "text", text: "```\nx\n```" }] })).toBeNull();
        expect(spokenAnswer(undefined)).toBeNull();
    });
});

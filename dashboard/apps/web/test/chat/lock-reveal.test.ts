// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { listenForReveal, maybeLockCode, revealLockedChats } from "@/app/(app)/chat/lock-reveal";

describe("Chat search and a hidden Locked chats entry", () => {
    it("treats a number no longer than the code as a possible code, never as a search", () => {
        expect(maybeLockCode("1", 6)).toBe(true);
        expect(maybeLockCode("123456", 6)).toBe(true);
        expect(maybeLockCode("1234567", 6)).toBe(false);
        expect(maybeLockCode("12a4", 6)).toBe(false);
        expect(maybeLockCode("", 6)).toBe(false);
    });

    it("opens the shelf on a sidebar already mounted, once", () => {
        const open = vi.fn();
        const stop = listenForReveal(open);
        revealLockedChats();
        expect(open).toHaveBeenCalledTimes(1);
        stop();
        revealLockedChats();
        expect(open).toHaveBeenCalledTimes(1);
    });

    it("opens the shelf on the next mount when the search navigated first", () => {
        revealLockedChats();
        const open = vi.fn();
        const stop = listenForReveal(open);
        expect(open).toHaveBeenCalledTimes(1);
        stop();
        const later = vi.fn();
        listenForReveal(later)();
        expect(later).not.toHaveBeenCalled();
    });
});

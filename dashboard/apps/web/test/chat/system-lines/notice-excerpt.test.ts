/**
 * A notice as the quote over a reply to it carries it: the sentence the reader
 * sees, names resolved, cut to one line.
 */

import { describe, expect, it } from "vitest";
import { noticeExcerpt } from "@/lib/chat/notice-text";

const names = new Map([["grace", "Grace Hopper"]]);

describe("noticeExcerpt", () => {
    it("reads the people by what they are called now", () => {
        expect(noticeExcerpt("[Grace H](polaris:user/grace) joined", names, "ada", 160)).toBe(
            "Grace Hopper joined"
        );
    });

    it("calls the reader 'You'", () => {
        expect(noticeExcerpt("[Grace H](polaris:user/grace) joined", names, "grace", 160)).toBe(
            "You joined"
        );
    });

    it("keeps a line that names nobody as it is", () => {
        const body = "The call ended after 1 hour 48 minutes";
        expect(noticeExcerpt(body, names, "ada", 160)).toBe(body);
    });

    it("leaves a name's punctuation alone rather than reading it as Markdown", () => {
        const odd = new Map([["bob", "*bob*_x_"]]);
        expect(noticeExcerpt("[b](polaris:user/bob) left", odd, null, 160)).toBe("*bob*_x_ left");
    });

    it("cuts a long one on a word, the way a quote of a message is cut", () => {
        const body = "The call ended after 1 hour 48 minutes";
        expect(noticeExcerpt(body, names, null, 20)).toBe("The call ended...");
    });
});

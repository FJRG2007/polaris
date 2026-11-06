/**
 * A notice's words for whoever draws it: the sender and where it was said on
 * lines of their own in a desktop app that draws both, folded into the title
 * everywhere else so an older app or a browser still says it was mail.
 */

import { describe, expect, it } from "vitest";
import { browserNoticePayload, desktopNoticePayload, NOTICE_MARK } from "@/lib/notice-payload";

const MAIL = {
    title: "Ana",
    subtitle: "Email",
    combined: "New email from Ana",
    body: "Invoice",
    icon: "/api/avatar/u1"
};

describe("desktopNoticePayload", () => {
    it("hands an app that draws a subtitle and an icon each of them apart", () => {
        expect(desktopNoticePayload(MAIL, ["subtitle", "icon"])).toEqual({
            title: "Ana",
            subtitle: "Email",
            body: "Invoice",
            icon: "/api/avatar/u1"
        });
    });

    it("keeps the kind in the title for an app older than the subtitle", () => {
        expect(desktopNoticePayload(MAIL, undefined)).toEqual({
            title: "New email from Ana",
            body: "Invoice"
        });
        expect(desktopNoticePayload(MAIL, ["icon"])).toEqual({
            title: "New email from Ana",
            body: "Invoice",
            icon: "/api/avatar/u1"
        });
    });

    it("joins with a dash when the caller has no sentence for the two", () => {
        expect(desktopNoticePayload({ title: "Ana", subtitle: "#general" }, [])).toEqual({
            title: "Ana - #general"
        });
    });

    it("draws a notice without a subtitle as it always was", () => {
        expect(desktopNoticePayload({ title: "Deployed", body: "ok" }, ["subtitle"])).toEqual({
            title: "Deployed",
            body: "ok"
        });
    });
});

describe("browserNoticePayload", () => {
    it("folds the kind into the title and draws the mark, never a face", () => {
        expect(browserNoticePayload(MAIL)).toEqual({
            title: "New email from Ana",
            body: "Invoice",
            icon: NOTICE_MARK
        });
    });
});

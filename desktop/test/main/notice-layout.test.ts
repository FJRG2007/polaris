/**
 * A notice's words on each system: the sender as the title, where it was said
 * under it on macOS and beside it elsewhere, and only real pictures as its icon.
 */

import { describe, expect, it } from "vitest";
import { iconAcceptable, ICON_MAX_BYTES, noticeLayout } from "@/main/notice-layout";

describe("noticeLayout", () => {
    it("keeps the conversation as the subtitle on macOS", () => {
        expect(noticeLayout({ title: "Ada", subtitle: "#general", body: "hi" }, "darwin")).toEqual({
            title: "Ada",
            subtitle: "#general",
            body: "hi"
        });
    });

    it("joins the conversation to the title where there is no subtitle line", () => {
        for (const platform of ["win32", "linux"] as const) {
            expect(noticeLayout({ title: "Ada", subtitle: "Mail", body: "Invoice" }, platform)).toEqual({
                title: "Ada - Mail",
                body: "Invoice"
            });
        }
    });

    it("draws a notice without a subtitle exactly as before", () => {
        expect(noticeLayout({ title: "Deployed shop", body: "Serving" }, "win32")).toEqual({ title: "Deployed shop", body: "Serving" });
        expect(noticeLayout({ title: "Ada", subtitle: "  " }, "darwin")).toEqual({ title: "Ada", body: "" });
        expect(noticeLayout({ title: "Ada", subtitle: "Ada" }, "win32")).toEqual({ title: "Ada", body: "" });
    });

    it("clips a title long enough to push the body off the notice", () => {
        const { title } = noticeLayout({ title: "x".repeat(100), subtitle: "y".repeat(100) }, "win32");
        expect(title.length).toBe(120);
        expect(title.endsWith("...")).toBe(true);
    });
});

describe("iconAcceptable", () => {
    it("takes a PNG or JPEG of avatar size", () => {
        expect(iconAcceptable("image/png", 2048)).toBe(true);
        expect(iconAcceptable("image/jpeg; charset=binary", 2048)).toBe(true);
    });

    it("refuses what is not a picture the system decodes, empty or oversized", () => {
        expect(iconAcceptable("image/svg+xml", 2048)).toBe(false);
        expect(iconAcceptable("text/html", 2048)).toBe(false);
        expect(iconAcceptable(null, 2048)).toBe(false);
        expect(iconAcceptable("image/png", 0)).toBe(false);
        expect(iconAcceptable("image/png", ICON_MAX_BYTES + 1)).toBe(false);
    });
});

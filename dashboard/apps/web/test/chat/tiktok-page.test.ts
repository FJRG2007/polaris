import { describe, expect, it } from "vitest";
import { tiktokVideoOf } from "@/lib/chat/tiktok-page";

/** A video page cut down to the shape TikTok serves a fetch: a generic title,
 *  no `og:` tags, and the video in the rehydration script. */
function pageWith(item: unknown): string {
    const data = {
        __DEFAULT_SCOPE__: {
            "webapp.app-context": { language: "en" },
            "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: item } }
        }
    };
    const script = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`;
    return `<html><head><title>TikTok - Make Your Day</title></head><body>${script}</body></html>`;
}

describe("tiktokVideoOf", () => {
    it("reads the caption, the account and the cover", () => {
        const video = tiktokVideoOf(
            pageWith({
                id: "1",
                desc: " A caption ",
                author: { uniqueId: "somebody", nickname: "Some Body" },
                video: {
                    cover: "https://p16-sign.tiktokcdn-eu.com/cover.image?x-expires=9",
                    originCover: "https://p16-sign.tiktokcdn-eu.com/origin.image"
                }
            })
        );
        expect(video).toEqual({
            caption: "A caption",
            author: "Some Body",
            cover: "https://p16-sign.tiktokcdn-eu.com/cover.image?x-expires=9"
        });
    });

    it("names the handle when the account has no display name", () => {
        const video = tiktokVideoOf(pageWith({ desc: "", author: { uniqueId: "somebody" } }));
        expect(video).toEqual({ caption: "", author: "somebody", cover: null });
    });

    it("falls back to the original cover", () => {
        const video = tiktokVideoOf(
            pageWith({ author: { nickname: "A" }, video: { originCover: "https://x.test/o" } })
        );
        expect(video?.cover).toBe("https://x.test/o");
    });

    it("is null for a page with no video in it", () => {
        expect(tiktokVideoOf("<html><title>TikTok - Make Your Day</title></html>")).toBeNull();
        expect(tiktokVideoOf(pageWith({}))).toBeNull();
    });

    it("is null for a script that is not JSON or not the expected shape", () => {
        const broken =
            '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{nope</script>';
        expect(tiktokVideoOf(broken)).toBeNull();
        const unclosed = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{}';
        expect(tiktokVideoOf(unclosed)).toBeNull();
        expect(tiktokVideoOf(pageWith({ desc: 42, author: "nobody" }))).toBeNull();
    });
});

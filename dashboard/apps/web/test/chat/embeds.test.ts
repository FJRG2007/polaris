/**
 * Which links Polaris will put a player in for.
 *
 * The rule this is really testing is that the frame's address is *built* from
 * parts that were checked, never rewritten from the string somebody posted. An
 * embed is a page loaded inside Polaris, so "whatever came after the slash" is
 * not an id - it is an address an attacker chose, framed by a site the reader
 * trusts. Every id here has to look like one before anything is returned.
 */

import { describe, expect, it } from "vitest";
import { embedFor } from "../../src/lib/chat/embeds";

describe("YouTube", () => {
    it("plays a watch link", () => {
        const embed = embedFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(embed?.provider).toBe("YouTube");
        expect(embed?.url).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    });

    it("plays a share link, a short and an embed link", () => {
        for (const address of [
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ"
        ]) {
            expect(embedFor(address)?.url).toContain("dQw4w9WgXcQ");
        }
    });

    it("keeps the moment a link was posted at", () => {
        // Somebody who links to 1:26 meant 1:26.
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ?t=86s")?.url).toBe(
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=86"
        );
    });

    it("uses the no-cookie host", () => {
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ")?.url).toContain("youtube-nocookie.com");
    });

    it("refuses anything that is not an id", () => {
        // The whole point: what comes after the slash is not trusted to be a
        // video, because the answer is put into a frame's src.
        expect(embedFor("https://youtu.be/../../evil")).toBeNull();
        expect(embedFor("https://www.youtube.com/watch?v=x")).toBeNull();
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ%2F%2Fevil.example")).toBeNull();
        expect(embedFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ'onload='")).toBeNull();
    });

    it("is not fooled by a hostname that merely ends in one it knows", () => {
        expect(embedFor("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
        expect(embedFor("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    });
});

describe("Vimeo", () => {
    it("plays a numbered video", () => {
        expect(embedFor("https://vimeo.com/76979871")?.url).toBe(
            "https://player.vimeo.com/video/76979871"
        );
    });

    it("refuses one with no number in it", () => {
        expect(embedFor("https://vimeo.com/channels/staffpicks")).toBeNull();
    });
});

describe("Spotify", () => {
    it("plays a track as a strip and an album as a panel", () => {
        const track = embedFor("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
        expect(track?.url).toBe("https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT");
        expect(track?.shape).toBe("audio");
        expect(embedFor("https://open.spotify.com/album/4cOdK2wGLETKBW3PvgPWqT")?.shape).toBe(
            "video"
        );
    });

    it("finds the thing past a localised prefix", () => {
        expect(embedFor("https://open.spotify.com/intl-es/track/4cOdK2wGLETKBW3PvgPWqT")?.url).toBe(
            "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"
        );
    });

    it("refuses a kind it does not know", () => {
        expect(embedFor("https://open.spotify.com/user/4cOdK2wGLETKBW3PvgPWqT")).toBeNull();
    });
});

describe("everything else", () => {
    it("has no player, and gets the ordinary card", () => {
        expect(embedFor("https://example.com/article")).toBeNull();
        expect(embedFor("not a url at all")).toBeNull();
        // A scheme that is not the web is not something to frame.
        expect(embedFor("javascript:alert(1)")).toBeNull();
        expect(embedFor("data:text/html,<script>alert(1)</script>")).toBeNull();
    });
});

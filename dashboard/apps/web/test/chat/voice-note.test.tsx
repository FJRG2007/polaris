/**
 * The player under a voice message, as it is first drawn.
 *
 * The one thing worth holding still: nothing is fetched until somebody presses
 * play. A conversation with forty recordings in it must not pull forty files off
 * the NAS to draw a scrollbar, which is what `preload="none"` is for and what
 * would quietly stop being true if the element ever grew an `autoplay` or a
 * `preload="auto"`.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceNote } from "@/app/(app)/chat/voice-note";

describe("a recording", () => {
    const markup = renderToStaticMarkup(
        <VoiceNote href="/api/chat/attachments/x" name="voice-message.webm" recorded={true} />
    );

    it("asks for nothing until it is played", () => {
        expect(markup).toContain('preload="none"');
        expect(markup).toContain('src="/api/chat/attachments/x"');
        expect(markup).not.toContain("autoplay");
    });

    it("does not show a name nobody chose", () => {
        expect(markup).not.toContain("voice-message.webm");
    });

    it("offers to play it", () => {
        expect(markup).toContain("Play this message");
    });
});

describe("a track somebody attached", () => {
    it("keeps its name", () => {
        const markup = renderToStaticMarkup(
            <VoiceNote href="/api/chat/attachments/y" name="interview.mp3" recorded={false} />
        );
        expect(markup).toContain("interview.mp3");
    });
});

/**
 * The player under a voice message, as it is first drawn.
 *
 * Two things are worth holding still. Nothing is fetched until somebody presses
 * play - a conversation with forty recordings in it must not pull forty files
 * off the NAS to draw a scrollbar - and the length and the shape are drawn from
 * what was stored with the message, because a stream recorded in a browser
 * carries no duration in it and reading one out means downloading all of it.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceNote } from "@/app/(app)/chat/voice-note";

describe("a recording", () => {
    const markup = renderToStaticMarkup(
        <VoiceNote
            href="/api/chat/attachments/x"
            name="voice-message.webm"
            recorded={true}
            durationMs={7400}
            waveform="0123456789"
        />
    );

    it("asks for nothing until it is played", () => {
        expect(markup).toContain('preload="none"');
        expect(markup).toContain('src="/api/chat/attachments/x"');
        expect(markup).not.toContain("autoplay");
    });

    it("says how long it is without opening it", () => {
        expect(markup).toContain("0:07");
    });

    it("draws a bar for every one it was given", () => {
        expect(markup.match(/min-w-px/g) ?? []).toHaveLength(10);
    });

    it("does not show a name nobody chose", () => {
        expect(markup).not.toContain("voice-message.webm");
    });

    it("offers to play it", () => {
        expect(markup).toContain("Play this message");
    });
});

describe("a track somebody attached", () => {
    const markup = renderToStaticMarkup(
        <VoiceNote
            href="/api/chat/attachments/y"
            name="interview.mp3"
            recorded={false}
            durationMs={null}
            waveform={null}
        />
    );

    it("keeps its name", () => {
        expect(markup).toContain("interview.mp3");
    });

    it("falls back to a plain bar, since nobody measured it", () => {
        expect(markup).toContain('type="range"');
        expect(markup).not.toContain("min-w-px");
    });
});

describe("how fast it plays", () => {
    it("starts at ordinary speed, with the way to change it in reach", () => {
        const markup = renderToStaticMarkup(
            <VoiceNote
                href="/api/chat/attachments/z"
                name="voice-message.webm"
                recorded={true}
                durationMs={4000}
                waveform="55"
            />
        );
        // One times, drawn as the button that walks through 1, 1.5 and 2 - the
        // same three every messenger settled on.
        expect(markup).toContain(">1x<");
        expect(markup).toContain("Press to change");
    });
});

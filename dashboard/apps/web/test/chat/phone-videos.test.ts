/**
 * A clip picked from a phone's gallery.
 *
 * Android's picker often hands the page a file with no type at all, and phone
 * cameras write QuickTime and 3GPP as well as MP4. Each of those has to be
 * recorded as the video it is, drawn with the player, and served as itself - not
 * stored as an opaque download that the conversation shows as a file to save.
 */

import { describe, expect, it } from "vitest";
import { isPlayableMedia } from "@/lib/chat/attachments";
import { isWatchableVideo, typeOfFile } from "@/lib/mime";
import { isVideoFile } from "@/app/(app)/chat/video-poster";

describe("what a picked file is", () => {
    it("keeps the type the browser gave", () => {
        expect(typeOfFile("video/mp4", "clip.bin")).toBe("video/mp4");
        expect(typeOfFile("audio/webm;codecs=opus", "voice.webm")).toBe("audio/webm;codecs=opus");
    });

    it("reads the name when the browser gave no type", () => {
        expect(typeOfFile("", "VID-20261103-WA0008.mp4")).toBe("video/mp4");
        expect(typeOfFile(null, "IMG_0042.MOV")).toBe("video/quicktime");
        expect(typeOfFile(undefined, "VID_20261106.3gp")).toBe("video/3gpp");
    });

    it("reads the name when the type is only the generic one", () => {
        expect(typeOfFile("application/octet-stream", "clip.mp4")).toBe("video/mp4");
    });

    it("stays an opaque download when neither says anything", () => {
        expect(typeOfFile("", "notes")).toBe("application/octet-stream");
        expect(typeOfFile("application/octet-stream", "data.xyz")).toBe("application/octet-stream");
    });
});

describe("which videos get the player", () => {
    it.each(["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/3gpp", "VIDEO/MP4"])(
        "draws %s as a video and serves it as itself",
        (type) => {
            expect(isWatchableVideo(type)).toBe(true);
            expect(isVideoFile(type)).toBe(true);
            expect(isPlayableMedia(type)).toBe(true);
        }
    );

    it("leaves everything else a download", () => {
        for (const type of ["application/octet-stream", "video/x-made-up", "text/html", ""]) {
            expect(isWatchableVideo(type)).toBe(false);
            expect(isPlayableMedia(type)).toBe(false);
        }
    });
});

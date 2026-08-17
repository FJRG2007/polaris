/**
 * The relay's own configuration, checked against the code that calls it.
 *
 * Two lines in a YAML file took every camera off every screen and neither of
 * them looked wrong. `allow_paths` is matched whole rather than as a prefix, so
 * a list that covers `/api/stream.m3u8` and not the four files the playlist then
 * asks for is a 404 per segment - a stream that plays nowhere on an Apple device,
 * which is the only reason HLS is there at all. And `streams: {}` is a mapping
 * go2rtc's config writer cannot add a line to, so every attempt to publish a
 * camera failed the write, answered 400, and left the camera half-published: the
 * good stream serving and the small one - the one the wall draws stills from -
 * missing.
 *
 * Both are invisible in review and neither can be caught by a type. So the paths
 * the code dials are read out of the code, and the allowlist is read out of the
 * file that ships.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HLS_FILES, hlsAssetPath, hlsMasterPath, streamPath } from "@/lib/home/relay";

const ENTRYPOINT = readFileSync(join(process.cwd(), "../../services/camera-relay/entrypoint.sh"), "utf8");

/** The allowlist as the relay will read it: the items under `allow_paths`, up to
 *  the blank line that ends the block. */
function allowedPaths(): string[] {
    const lines = ENTRYPOINT.split("\n");
    const start = lines.findIndex((line) => line.trim() === "allow_paths:");
    expect(start).toBeGreaterThan(-1);
    const paths: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const match = /^\s+- (\/\S+)$/.exec(line);
        if (!match) break;
        paths.push(match[1]!);
    }
    return paths;
}

/** A path the code dials, without the query the relay does not match on. */
function pathOnly(url: string): string {
    return url.split("?")[0]!;
}

describe("the relay allowlist", () => {
    const allowed = allowedPaths();

    it("covers every file an HLS player fetches, each named in full", () => {
        const assets = HLS_FILES.filter((file) => file !== "stream.m3u8") as Exclude<
            (typeof HLS_FILES)[number],
            "stream.m3u8"
        >[];
        expect(assets.length).toBeGreaterThan(0);
        for (const file of assets) {
            expect(allowed).toContain(pathOnly(hlsAssetPath(file, "aB3xY9zQ", "1")));
        }
    });

    it("covers what a viewer, a tile and a publish each ask for", () => {
        for (const path of [
            pathOnly(hlsMasterPath("cam1", "main")),
            pathOnly(streamPath("cam1", "mp4")),
            pathOnly(streamPath("cam1", "webrtc")),
            pathOnly(streamPath("cam1", "ws")),
            "/api/frame.jpeg",
            "/api/streams"
        ]) {
            expect(allowed).toContain(path);
        }
    });

    it("opens nothing else - the API can add a stream that reads a file off the machine", () => {
        for (const path of allowed) expect(path.startsWith("/api/")).toBe(true);
        expect(allowed).not.toContain("/api/config");
    });
});

describe("the streams section", () => {
    it("is left bare, because an inline mapping fails every write go2rtc makes to it", () => {
        expect(ENTRYPOINT).not.toMatch(/^\s*(echo\s+")?streams:\s*\{/m);
        expect(ENTRYPOINT).toContain('echo "streams:"');
    });

    it("keeps the cameras the relay already had, rather than templating over them", () => {
        expect(ENTRYPOINT).toContain("sed -n '/^streams:/,$p' \"$CONFIG\" | tail -n +2");
    });
});

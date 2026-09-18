/**
 * Matching a path against an app's routes the way Next matched its file tree.
 */

import { describe, expect, it } from "vitest";
import { matchRoute } from "@/lib/app-bundles/route-match";

const ROUTES = [
    "/places",
    "/places/cameras",
    "/api/home/cameras/[id]/stream",
    "/api/home/cameras/[id]/hls/[file]",
    "/api/home/cameras/detections",
    "/api/minecraft/pack/[id]/[token]/[file]",
    "/api/files/[...path]",
    "/docs/[[...slug]]"
];

describe("matchRoute", () => {
    it("answers a fixed path", () => {
        expect(matchRoute(ROUTES, "/places")).toEqual({ pattern: "/places", params: {} });
        expect(matchRoute(ROUTES, "/places/cameras")?.pattern).toBe("/places/cameras");
    });

    it("names each parameter, decoded", () => {
        expect(matchRoute(ROUTES, "/api/home/cameras/cam%201/hls/index.m3u8")).toEqual({
            pattern: "/api/home/cameras/[id]/hls/[file]",
            params: { id: "cam 1", file: "index.m3u8" }
        });
    });

    it("prefers a fixed segment to a parameter", () => {
        expect(matchRoute(ROUTES, "/api/home/cameras/detections")?.pattern).toBe(
            "/api/home/cameras/detections"
        );
    });

    it("takes the rest of the path for a catch-all, and requires one segment of it", () => {
        expect(matchRoute(ROUTES, "/api/files/a/b.txt")?.params).toEqual({ path: ["a", "b.txt"] });
        expect(matchRoute(ROUTES, "/api/files")).toBeNull();
    });

    it("lets an optional catch-all match nothing", () => {
        expect(matchRoute(ROUTES, "/docs")).toEqual({ pattern: "/docs/[[...slug]]", params: {} });
        expect(matchRoute(ROUTES, "/docs/a/b")?.params).toEqual({ slug: ["a", "b"] });
    });

    it("answers nothing for a path no route has, or one segment too many", () => {
        expect(matchRoute(ROUTES, "/places/nowhere")).toBeNull();
        expect(matchRoute(ROUTES, "/api/home/cameras/1/stream/extra")).toBeNull();
    });

    it("refuses a segment that does not decode", () => {
        expect(matchRoute(ROUTES, "/api/home/cameras/%E0%A4%A/stream")).toBeNull();
    });
});

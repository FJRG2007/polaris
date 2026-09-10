/**
 * A finished deploy announced by both the push window and the dashboard's feed
 * is shown once; two deploys that read the same are shown twice.
 */

import { describe, expect, it } from "vitest";
import { ONCE_MS, OnceNotices } from "@/main/notice-once";

const WORDS = "Deployed shop / api\nshop / api is serving the new release.";

function clock(): { now: () => number; advance: (ms: number) => void; } {
    let at = 1_000_000;
    return { now: () => at, advance: (ms) => (at += ms) };
}

describe("OnceNotices", () => {
    it("drops the other announcer's notice for the same deploy, in either order", () => {
        const pushFirst = new OnceNotices(clock().now);
        expect(pushFirst.repeated("deploy:d1", WORDS)).toBe(false);
        expect(pushFirst.repeated("notification:n1", WORDS)).toBe(true);

        const feedFirst = new OnceNotices(clock().now);
        expect(feedFirst.repeated("notification:n1", WORDS)).toBe(false);
        expect(feedFirst.repeated("deploy:d1", WORDS)).toBe(true);
    });

    it("shows a second push of the same service, and pairs each with its own alert", () => {
        const time = clock();
        const said = new OnceNotices(time.now);
        expect(said.repeated("deploy:d1", WORDS)).toBe(false);
        time.advance(30_000);
        expect(said.repeated("deploy:d2", WORDS)).toBe(false);
        expect(said.repeated("notification:n2", WORDS)).toBe(true);
        expect(said.repeated("notification:n3", WORDS)).toBe(false);
    });

    it("forgets the words once the window has passed", () => {
        const time = clock();
        const said = new OnceNotices(time.now);
        expect(said.repeated("deploy:d1", WORDS)).toBe(false);
        time.advance(ONCE_MS + 1);
        expect(said.repeated("notification:n1", WORDS)).toBe(false);
    });

    it("never pairs different words", () => {
        const said = new OnceNotices(clock().now);
        expect(said.repeated("deploy:d1", WORDS)).toBe(false);
        expect(said.repeated("notification:n1", "Deploy failed: shop / api\nexit 1")).toBe(false);
    });
});

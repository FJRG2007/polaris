/**
 * Who counts as already looking at the page an alert points at.
 *
 * The whole value of this is in what it refuses. Suppressing the badge for
 * somebody watching the screen is a nicety; suppressing it for somebody who is
 * merely near the screen - one page up, on a stale report, on another account -
 * is an alert that was raised and never seen, which is the failure the bell
 * exists to prevent. So most of what is asserted here is a false.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    dropPresence,
    isViewing,
    PRESENCE_TTL_MS,
    recordPresence,
    resetPresence,
    viewPath
} from "../../src/lib/notifications/presence";

const USER = "user-1";
const TAB = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    resetPresence();
});

describe("reading a link as a screen", () => {
    it("keeps the path and drops the query, the fragment and a trailing slash", () => {
        expect(viewPath("/apps/deploy/p1?service=s1")).toBe("/apps/deploy/p1");
        expect(viewPath("/apps/deploy/p1#logs")).toBe("/apps/deploy/p1");
        expect(viewPath("/apps/deploy/p1/")).toBe("/apps/deploy/p1");
        expect(viewPath("/")).toBe("/");
    });

    it("refuses anything that is not an in-app path", () => {
        expect(viewPath("https://example.com/apps/deploy/p1")).toBeNull();
        expect(viewPath("apps/deploy/p1")).toBeNull();
        expect(viewPath(null)).toBeNull();
        expect(viewPath(undefined)).toBeNull();
    });
});

describe("deciding somebody is watching", () => {
    it("matches the screen whatever the alert hangs off its query", () => {
        recordPresence(USER, TAB, "/apps/deploy/p1");
        // The deploy alert links at one service; the reader has the project open.
        expect(isViewing(USER, "/apps/deploy/p1?service=s1")).toBe(true);
    });

    it("does not treat a page above the alert as seeing it", () => {
        recordPresence(USER, TAB, "/tasks");
        expect(isViewing(USER, "/tasks/t/abc")).toBe(false);
    });

    it("does not treat a page below the alert as seeing it", () => {
        recordPresence(USER, TAB, "/tasks/t/abc");
        // A different task's page is not this task's page, and the list above
        // them both does not show what happened to either.
        expect(isViewing(USER, "/tasks/t/other")).toBe(false);
        expect(isViewing(USER, "/tasks")).toBe(false);
    });

    it("is scoped to the account that reported it", () => {
        recordPresence(USER, TAB, "/account/sessions");
        expect(isViewing("user-2", "/account/sessions")).toBe(false);
    });

    it("stops believing a report nothing has repeated", () => {
        const at = 1_000_000;
        recordPresence(USER, TAB, "/watch", at);
        expect(isViewing(USER, "/watch", at + PRESENCE_TTL_MS)).toBe(true);
        expect(isViewing(USER, "/watch", at + PRESENCE_TTL_MS + 1)).toBe(false);
    });

    it("forgets a tab that withdrew", () => {
        recordPresence(USER, TAB, "/watch");
        dropPresence(USER, TAB);
        expect(isViewing(USER, "/watch")).toBe(false);
    });

    it("never matches a link that leaves Polaris", () => {
        recordPresence(USER, TAB, "/watch");
        expect(isViewing(USER, "https://example.com/watch")).toBe(false);
        expect(isViewing(USER, null)).toBe(false);
    });

    it("follows the tab as it navigates rather than holding both pages open", () => {
        recordPresence(USER, TAB, "/apps/deploy/p1");
        recordPresence(USER, TAB, "/tasks");
        expect(isViewing(USER, "/apps/deploy/p1")).toBe(false);
        expect(isViewing(USER, "/tasks")).toBe(true);
    });

    it("caps what one account can hold, dropping the oldest report first", () => {
        // A client minting ids must not be able to grow this without bound, and
        // what survives the cap has to be the tabs most recently heard from.
        for (let index = 0; index < 40; index += 1) {
            recordPresence(USER, `tab-${index}`, `/page-${index}`, 1_000_000 + index);
        }
        expect(isViewing(USER, "/page-0", 1_000_040)).toBe(false);
        expect(isViewing(USER, "/page-39", 1_000_040)).toBe(true);
    });
});

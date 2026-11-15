/**
 * An agent session on screen keeps its own alerts quiet, and only its own.
 *
 * Every session is drawn on /polar and the address goes back to plain /polar
 * once one is opened, so matching on the path would let any Polar tab swallow
 * the alert about a session it is not showing. The tab reports the session as
 * a subject instead, and an alert that names one is matched on it alone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { sessionViewSubject, viewSubject } from "@/lib/notifications/view-subject";
import { isViewing, recordPresence, resetPresence } from "@/lib/notifications/presence";

const USER = "user-1";
const TAB = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => resetPresence());

describe("viewSubject", () => {
    it("names a session in one canonical form", () => {
        expect(viewSubject(`/polar?session=${A}`)).toBe(sessionViewSubject(A));
        expect(viewSubject(`/polar/?x=1&session=${A}#end`)).toBe(sessionViewSubject(A));
    });

    it("names nothing for other links", () => {
        expect(viewSubject("/polar")).toBeNull();
        expect(viewSubject("/polar?session=new")).toBeNull();
        expect(viewSubject("/polar?thread=abc")).toBeNull();
        expect(viewSubject(`/apps/deploy?session=${A}`)).toBeNull();
        expect(viewSubject(`//elsewhere.example/polar?session=${A}`)).toBeNull();
        expect(viewSubject(null)).toBeNull();
    });
});

describe("isViewing with a subject", () => {
    it("is quiet for the session on screen, wherever the tab is", () => {
        recordPresence(USER, TAB, "/apps/deploy", 1000, sessionViewSubject(A));
        expect(isViewing(USER, sessionViewSubject(A), 2000)).toBe(true);
    });

    it("is not quiet for another session open on /polar", () => {
        recordPresence(USER, TAB, "/polar", 1000, sessionViewSubject(B));
        expect(isViewing(USER, sessionViewSubject(A), 2000)).toBe(false);
    });

    it("is not quiet for /polar with no session open", () => {
        recordPresence(USER, TAB, "/polar", 1000);
        expect(isViewing(USER, sessionViewSubject(A), 2000)).toBe(false);
        // A link to /polar itself still matches on the path, as before.
        expect(isViewing(USER, "/polar", 2000)).toBe(true);
    });

    it("forgets the session once the report goes stale", () => {
        recordPresence(USER, TAB, "/polar", 1000, sessionViewSubject(A));
        expect(isViewing(USER, sessionViewSubject(A), 1000 + 46000)).toBe(false);
    });

    it("never suppresses for another account", () => {
        recordPresence(USER, TAB, "/polar", 1000, sessionViewSubject(A));
        expect(isViewing("user-2", sessionViewSubject(A), 2000)).toBe(false);
    });

    it("drops a subject that names nothing it knows", () => {
        recordPresence(USER, TAB, "/polar", 1000, "/elsewhere?session=x");
        expect(isViewing(USER, "/elsewhere?session=x", 2000)).toBe(false);
    });
});

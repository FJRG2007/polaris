/**
 * Which dashboards a bundle runs on: the caret range on the host API, and the
 * one value the bundler and the dashboard must agree on.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_API, hostApiVerdict, parseHostApi } from "../src/version";

describe("the host API version", () => {
    it("is the value the bundler reads from package.json", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        expect(pkg.hostApi).toBe(HOST_API);
        expect(parseHostApi(HOST_API)).not.toBeNull();
    });

    it("reads only MAJOR.MINOR", () => {
        expect(parseHostApi("1.2")).toEqual([1, 2]);
        expect(parseHostApi(" 3.0 ")).toEqual([3, 0]);
        for (const bad of ["1", "1.2.3", "01.0", "a.b", "", null, 1.2, "-1.0"]) {
            expect(parseHostApi(bad)).toBeNull();
        }
    });
});

describe("whether an app runs on a dashboard", () => {
    it("runs on the same major with at least its minor", () => {
        expect(hostApiVerdict("1.0", "1.0")).toEqual({ ok: true });
        expect(hostApiVerdict("1.2", "1.5")).toEqual({ ok: true });
    });

    it("needs a newer dashboard when it asks for more", () => {
        expect(hostApiVerdict("1.6", "1.5")).toEqual({ ok: false, update: "dashboard" });
        expect(hostApiVerdict("2.0", "1.9")).toEqual({ ok: false, update: "dashboard" });
    });

    it("needs its own update when the dashboard moved past its major", () => {
        expect(hostApiVerdict("1.9", "2.0")).toEqual({ ok: false, update: "app" });
    });

    it("treats a bundle with no requirement as built against 1.0", () => {
        expect(hostApiVerdict(undefined, "1.0")).toEqual({ ok: true });
        expect(hostApiVerdict(undefined, "2.0")).toEqual({ ok: false, update: "app" });
    });

    it("sends an unreadable requirement to a dashboard update", () => {
        expect(hostApiVerdict("v1", "1.0")).toEqual({ ok: false, update: "dashboard" });
    });
});

/**
 * The vacant page is served to whoever asks for a name in the wildcard zone, which is
 * everyone - including whoever is walking it. So what is tested here is that it says
 * which of the two nothings it is, that the state cannot be chosen by the visitor, and
 * that a hostname straight out of a request header is placed as text and not as markup.
 */

import { describe, expect, it } from "vitest";
import {
    VACANT_DOWN_PATH,
    VACANT_PATH,
    vacantCode,
    vacantPage,
    vacantStateForPath,
    vacantStatus
} from "../src/vacant-page.js";

const REFERENCE = "2f9a1c5e-7b64-4c2f-9a3d-16b0c8f4e7d1";

describe("vacantPage", () => {
    it("says nothing is deployed on a name no app claims", () => {
        const page = vacantPage({ reference: REFERENCE, host: "gone.plr.example.com", state: "missing" });

        expect(page).toContain("There is nothing running here");
        expect(page).toContain("gone.plr.example.com");
        expect(page).toContain("NO_SERVICE_HERE");
        expect(page).toContain(REFERENCE);
    });

    it("says the app is stopped when one is deployed and not answering", () => {
        const page = vacantPage({ reference: REFERENCE, host: "app.plr.example.com", state: "down" });

        expect(page).toContain("This app is not running");
        expect(page).toContain("SERVICE_NOT_RUNNING");
        expect(page).not.toContain("nothing is deployed on it");
    });

    it("escapes a host that carries markup", () => {
        const page = vacantPage({ reference: REFERENCE, host: "<script>alert(1)</script>", state: "missing" });

        expect(page).not.toContain("<script>alert(1)</script>");
        expect(page).toContain("&lt;script&gt;");
    });

    it("caps a header long enough to be a payload of its own", () => {
        const page = vacantPage({ reference: REFERENCE, host: "a".repeat(5000), state: "missing" });

        expect(page).not.toContain("a".repeat(200));
    });

    it("keeps its own name out of what it tells a visitor about the instance", () => {
        const page = vacantPage({ reference: REFERENCE, host: "gone.plr.example.com", state: "missing" });

        expect(page).not.toContain("polaris-app-");
        expect(page).not.toContain("plr.example.com/");
    });
});

describe("the state a request is answered in", () => {
    it("is missing for the path the catch-all rewrites to", () => {
        expect(vacantStateForPath(VACANT_PATH)).toBe("missing");
        expect(vacantStatus("missing")).toBe(404);
        expect(vacantCode("missing")).toBe("NO_SERVICE_HERE");
    });

    it("is down only for the path an error page asks for", () => {
        expect(vacantStateForPath(VACANT_DOWN_PATH)).toBe("down");
        expect(vacantStatus("down")).toBe(502);
        expect(vacantCode("down")).toBe("SERVICE_NOT_RUNNING");
    });

    it("cannot be claimed by a visitor's own query string", () => {
        // Traefik's path rewrite keeps whatever the visitor asked with, so this is the
        // shape a request for `/?state=down` arrives in.
        expect(vacantStateForPath(`${VACANT_PATH}?state=down`)).toBe("missing");
        expect(vacantStateForPath(`${VACANT_PATH}?status=502`)).toBe("missing");
        expect(vacantStateForPath(`${VACANT_PATH}/../down`)).toBe("missing");
    });
});

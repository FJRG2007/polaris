/**
 * The codes an account has answered, on the screen that answers them.
 *
 * Scanning one signs a device in as you, and the session it opens looks like any
 * other on the list - so if this history does not say what was let in and which
 * of your devices let it, a code allowed by mistake leaves nothing anybody would
 * notice. Refusals are part of that: a code somebody else put in front of you is
 * refused once and matters more than the twenty that were allowed.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QrSignInAnswer } from "@/lib/qr-sign-in-service";
import { ScanHistory } from "../../src/app/(app)/account/scan/scan-history";

function answer(overrides: Partial<QrSignInAnswer> = {}): QrSignInAnswer {
    return {
        id: "audit-1",
        at: "2026-08-04T10:00:00.000Z",
        allowed: true,
        device: "Chrome on Windows",
        origin: "203.0.113.9 - ES",
        host: "polaris.example.com",
        scannedOn: "Safari on iOS",
        here: false,
        ...overrides
    };
}

const render = (answers: QrSignInAnswer[]) => renderToStaticMarkup(<ScanHistory answers={answers} />);

describe("the scan history", () => {
    it("says what was let in, from where, and which device read the code", () => {
        const markup = render([answer()]);
        expect(markup).toContain("Chrome on Windows");
        expect(markup).toContain("203.0.113.9 - ES");
        expect(markup).toContain("polaris.example.com");
        expect(markup).toContain("Read on Safari on iOS");
        expect(markup).toContain("Signed in");
    });

    it("keeps a refusal as a refusal", () => {
        const markup = render([answer({ allowed: false })]);
        expect(markup).toContain("Refused");
        expect(markup).not.toContain(">Signed in<");
    });

    it("marks the device reading the page when it is the one that scanned", () => {
        expect(render([answer({ here: true })])).toContain("This device");
    });

    // Saying nothing here would read as a code that answered itself.
    it("admits when the device that read a code is no longer signed in", () => {
        expect(render([answer({ scannedOn: null })])).toContain(
            "Read on a device that is no longer signed in"
        );
    });

    it("renders a row per answer rather than dropping any", () => {
        const answers = Array.from({ length: 5 }, (_, index) => answer({ id: `audit-${index}` }));
        expect(render(answers).match(/<li/g)).toHaveLength(5);
    });

    it("says so on an account that has never answered one", () => {
        expect(render([])).toContain("You have not answered a sign-in code yet.");
    });
});

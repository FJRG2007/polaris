import { describe, expect, it } from "vitest";
import { passkeyProblem } from "@/app/(app)/account/security/known-sentences";

/** A translator that answers with the key it was asked for. */
const t = ((key: string) => key) as never;
const tv = ((key: string) => key) as never;
const FALLBACK = "passkeys.notCompleted";

describe("a passkey that was not added", () => {
    it("reads as cancelled when the device prompt was dismissed or left waiting", () => {
        const browser = "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
        expect(passkeyProblem(t, tv, { code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", message: browser }, FALLBACK)).toBe(
            "passkeys.cancelled"
        );
        expect(passkeyProblem(t, tv, { code: "ERROR_CEREMONY_ABORTED" }, FALLBACK)).toBe("passkeys.cancelled");
    });

    it("says the device already holds one, and when the address cannot make them", () => {
        expect(passkeyProblem(t, tv, { code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" }, FALLBACK)).toBe(
            "passkeys.alreadyHere"
        );
        expect(passkeyProblem(t, tv, { code: "ERROR_INVALID_DOMAIN" }, FALLBACK)).toBe("passkeys.addressRefused");
    });

    it("never shows the browser's own sentence for any other prompt answer", () => {
        expect(passkeyProblem(t, tv, { code: "ERROR_INVALID_USER_ID_LENGTH", message: "raw browser text" }, FALLBACK)).toBe(
            FALLBACK
        );
    });

    it("keeps the fallback when nothing was said", () => {
        expect(passkeyProblem(t, tv, {}, FALLBACK)).toBe(FALLBACK);
    });
});

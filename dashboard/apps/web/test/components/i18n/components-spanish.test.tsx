/**
 * The shared components a signed-in person meets on their account, in Spanish.
 *
 * How a session signed in is named by core in English for the audit log; on
 * screen it is said through the `components` catalog, so English is held to
 * core's own words here and a few of the components are drawn in Spanish.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SECOND_FACTORS, signInSummary, type SignInRecord } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { clientKindText, signInText } from "@/lib/sign-in-words";
import { clientKindLabel } from "@/lib/vault/client-device";
import { withMessages } from "../../setup/i18n";

// The step-up fields ask the server what they may offer; here they never hear back.
vi.mock("@/app/(app)/account/step-up-actions", () => ({
    sendStepUpCodeAction: vi.fn(),
    stepUpOptionsAction: () => new Promise(() => undefined)
}));

const { PasswordState } = await import("@/components/password-state");
const { StepUpFields } = await import("@/components/step-up-fields");

const english = translatorFor("en-US", "components");
const spanish = translatorFor("es-ES", "components");

describe("how a session signed in", () => {
    it("reads in English exactly as core writes it", () => {
        const records: SignInRecord[] = [
            { method: null, secondFactor: null },
            { method: "password", secondFactor: null },
            { method: "passkey", secondFactor: null },
            { method: "email-link", secondFactor: "email-code" },
            { method: "qr-code", secondFactor: null },
            ...SECOND_FACTORS.map((secondFactor) => ({ method: "password" as const, secondFactor }))
        ];
        for (const record of records) expect(signInText(english, record)).toBe(signInSummary(record));
        for (const kind of ["extension", "browser", "mobile", "desktop", "cli", "other"] as const) {
            expect(clientKindText(english, kind)).toBe(clientKindLabel(kind as never));
        }
    });

    it("reads in Spanish", () => {
        expect(signInText(spanish, { method: "password", secondFactor: "totp" })).toBe(
            "Contraseña + App de autenticación"
        );
        expect(signInText(spanish, { method: null, secondFactor: null })).toBe("Sin registrar");
    });
});

describe("drawn in Spanish", () => {
    it("says how strong a password is", () => {
        const html = renderToStaticMarkup(withMessages(<PasswordState password="correct horse battery staple" />, "es-ES"));
        expect(html).toMatch(/Excelente|Fuerte|Regular|Débil/);
    });

    it("says it is working out how to confirm", () => {
        const html = renderToStaticMarkup(
            withMessages(<StepUpFields open={false} purpose="test" onChange={() => undefined} />, "es-ES")
        );
        expect(html).toContain("Averiguando cómo confirmar esto");
    });
});

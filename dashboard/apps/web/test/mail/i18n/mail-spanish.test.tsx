/**
 * Mail, drawn in Spanish.
 *
 * The mailbox layer refuses in English, a spam verdict is written in English by
 * the filter, and core's option labels stay English for the API - so each of
 * those is a sentence the screen has to put into the reader's words on its own.
 * What is asserted is that it does, that a value inside one survives the trip,
 * and that a mail server's own words are left as they came.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined })
}));

const { RefusedMailboxes } = await import("@/app/(app)/mail/refused-notice");
const { mailRefusalText } = await import("@/lib/mailbox/refusal-text");
const { spamReasonText } = await import("@/app/(app)/mail/spam-reason");
const { mailOptionLabel } = await import("@/app/(app)/mail/option-label");
const { translatorFor } = await import("@/lib/i18n/translate");

const t = translatorFor("es-ES", "mail");

describe("the notice for a mailbox that stopped signing in", () => {
    function notice(auth: "password" | "oauth"): string {
        return renderToStaticMarkup(
            withMessages(
                <RefusedMailboxes accounts={[{ id: "m1", address: "ana@example.com", auth, state: "auth" }]} />,
                "es-ES"
            )
        );
    }

    it("says what happened and offers the fix in Spanish", () => {
        const markup = notice("password");
        expect(markup).toContain("ana@example.com ha dejado de aceptar su contraseña");
        expect(markup).toContain("Actualizar contraseña");
        expect(markup).not.toContain("Update password");
    });

    it("says reconnect for an authorized mailbox", () => {
        expect(notice("oauth")).toContain("Volver a conectar");
    });
});

describe("a refusal from the mailbox layer", () => {
    it("is said in Spanish", () => {
        expect(mailRefusalText(t, "That folder is not yours.")).toBe("Esa carpeta no es tuya.");
    });

    it("keeps the value it carries", () => {
        expect(mailRefusalText(t, "You already have a label called Facturas.")).toContain("Facturas");
        expect(mailRefusalText(t, "This mailbox has no trash folder.")).toContain("Papelera");
    });

    it("says why a send stopped, in Spanish on both halves", () => {
        const said = mailRefusalText(
            t,
            "That message could not be sent. Polaris has stopped trying after 5 attempts."
        );
        expect(said).toBe("No se pudo enviar ese mensaje. Polaris ha dejado de intentarlo tras 5 intentos.");
    });

    it("passes a mail server's own words through untouched", () => {
        const said = "550 5.1.1 <nobody@example.com>: Recipient address rejected";
        expect(mailRefusalText(t, said)).toBe(said);
    });
});

describe("why a message went to spam", () => {
    it("is said in Spanish", () => {
        expect(spamReasonText(t, "You blocked this sender")).toBe("Bloqueaste a este remitente");
    });

    it("agrees a count with its number", () => {
        expect(spamReasonText(t, "1 security engines flag this domain")).toBe(
            "1 motor de seguridad marca este dominio"
        );
        expect(spamReasonText(t, "4 security engines flag this domain")).toBe(
            "4 motores de seguridad marcan este dominio"
        );
    });

    it("keeps what the filter found", () => {
        expect(spamReasonText(t, "Replies would go to x@evil.example, not to ana@example.com")).toBe(
            "Las respuestas irían a x@evil.example, no a ana@example.com"
        );
    });
});

describe("a choice core only knows in English", () => {
    it("is shown in Spanish", () => {
        expect(mailOptionLabel(t, "folderRole", "inbox")).toBe("Recibidos");
        expect(mailOptionLabel(t, "folderRole", "trash")).toBe("Papelera");
    });
});

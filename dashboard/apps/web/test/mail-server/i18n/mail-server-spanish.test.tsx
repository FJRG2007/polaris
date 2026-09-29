/**
 * The mail server app, in Spanish.
 *
 * Most of what it says comes from somewhere that cannot ask for a language: core's
 * record labels and port list, the setup steps, the services' refusals and the
 * checks' conclusions, several of them stored and read back later. Each reaches the
 * screen through a table keyed by its English, so the English catalog is held to
 * those sources word for word here, and a sample of each is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import {
    gradeGreetingName,
    gradeReverseName,
    MAIL_SERVER_PORTS,
    MAIL_RECORD_LABELS,
    RELAY_PROVIDERS,
    type MailRecordPurpose
} from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceKey } from "@/lib/i18n/types";
import { SETUP_STEP_LABELS, SETUP_STEPS } from "@/lib/mail-server/steps";
import { KNOWN_MAIL_REFUSALS, mailServerRefusalText } from "@/lib/mail-server/refusal-text";
import { KNOWN_MAIL_NOTES, mailNoteText, mailSchemaText, portWords } from "@/lib/mail-server/words";

const english = translatorFor("en-US", "mailServer");
const spanish = translatorFor("es-ES", "mailServer");

describe("words that come from elsewhere, in English", () => {
    it("say exactly what their source says", () => {
        for (const message of KNOWN_MAIL_REFUSALS) expect(mailServerRefusalText(english, message)).toBe(message);
        for (const note of KNOWN_MAIL_NOTES) expect(mailNoteText(english, note)).toBe(note);
        for (const port of MAIL_SERVER_PORTS) expect(portWords(english, port)).toEqual({ label: port.label, purpose: port.purpose });
        for (const step of SETUP_STEPS) {
            const key = `steps.${step === "recovery-off" ? "recoveryOff" : step}` as NamespaceKey<"mailServer">;
            expect(english(key)).toBe(SETUP_STEP_LABELS[step]);
        }
        for (const [purpose, label] of Object.entries(MAIL_RECORD_LABELS)) {
            const key = purpose === "mta-sts" ? "mtaSts" : purpose === "tls-rpt" ? "tlsRpt" : purpose;
            expect(english(`dns.purposes.${key as MailRecordPurpose}` as NamespaceKey<"mailServer">)).toBe(label);
        }
        expect(english("sending.custom")).toBe(RELAY_PROVIDERS.find((entry) => entry.id === "custom")?.label);
    });

    it("keep the reverse-name checks' sentences whole", () => {
        const lookup = {
            address: "198.51.100.20",
            hostname: "mail.example.com",
            pointers: ["host-198-51-100-20.provider.example"],
            pointerAddresses: ["198.51.100.20"],
            hostAddresses: ["198.51.100.20"]
        };
        for (const check of [gradeReverseName(lookup), gradeGreetingName(lookup)]) {
            expect(mailNoteText(english, check.note)).toBe(check.note);
            if (check.instruction) expect(mailNoteText(english, check.instruction)).toBe(check.instruction);
        }
    });
});

describe("the same words, in Spanish", () => {
    it("reads a refusal that names a value", () => {
        expect(mailServerRefusalText(spanish, "example.org still has 2 mailboxes. Remove them first.")).toBe(
            "example.org aún tiene 2 buzones. Quítalos antes."
        );
        expect(mailServerRefusalText(spanish, "That mail server was not found.")).toBe("No se encuentra ese servidor de correo.");
    });

    it("reads a check's conclusion and a schema's complaint", () => {
        const note = gradeReverseName({
            address: "198.51.100.20",
            hostname: "mail.example.com",
            pointers: [],
            pointerAddresses: [],
            hostAddresses: []
        }).note;
        expect(mailNoteText(spanish, note)).toBe(
            "198.51.100.20 no tiene nombre inverso. Varios receptores grandes rechazan el correo de una dirección sin él antes de mirar nada más."
        );
        expect(mailSchemaText(spanish, "That is not a domain name")).toBe("Eso no es un nombre de dominio");
    });

    it("lets a sentence it does not know through unchanged", () => {
        expect(mailServerRefusalText(spanish, "Something the engine said")).toBe("Something the engine said");
        expect(mailNoteText(spanish, "Something the engine said")).toBe("Something the engine said");
    });
});

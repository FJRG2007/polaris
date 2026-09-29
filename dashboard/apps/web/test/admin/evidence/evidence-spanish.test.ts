/**
 * The compliance evidence, in Spanish.
 *
 * The report is built in the words it is handed - the reader's, from the
 * routes - and in English when it is handed none, which is what the rest of
 * these tests read. Here it is read in Spanish, screen and export alike, and
 * the figures stay as written.
 */

import { describe, expect, it } from "vitest";
import { readings } from "./fixtures";
import * as evidence from "@/lib/compliance/evidence";
import { evidenceMarkdown } from "@/lib/compliance/evidence-export";
import { evidenceWordsIn } from "@/lib/compliance/evidence-sections";

const spanish = evidenceWordsIn("es-ES");

describe("the evidence in Spanish", () => {
    it("names every area and says what it found", () => {
        const report = evidence.buildEvidence(readings(), spanish);
        const titles = report.sections.map((section) => section.title);
        expect(titles).toContain("Inicio de sesión y segundo factor");
        expect(titles).toContain("Copias de seguridad");
        expect(report.outsidePolaris[0]).toBe("Si están cifrados los discos de las máquinas en las que funciona Polaris.");
    });

    it("writes the export in the same words, with the figures as they are", () => {
        const base = readings();
        const report = evidence.buildEvidence(
            readings({ audit: { ...base.audit, lastVerification: { at: base.now.toISOString(), ok: true, checked: 5000, broken: null } } }),
            spanish
        );
        const audit = report.sections.find((section) => section.id === "audit");
        expect(audit?.facts.find((fact) => fact.id === "audit.last-check-result")?.text).toBe("Intacta en 5000 entradas");
        const markdown = evidenceMarkdown(report, "abc", spanish.t);
        expect(markdown).toContain("# Evidencias de configuración de Polaris");
        expect(markdown).toContain("| Control | Valor |");
    });
});

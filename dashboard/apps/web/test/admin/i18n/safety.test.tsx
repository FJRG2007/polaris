/**
 * The safety queue, drawn in both languages.
 *
 * The line under a settled case chooses three endings at once - who settled it,
 * when, and whether they said anything - so it is asserted whole, in English as
 * it always read and in Spanish. The case's labels used to come from constants
 * in core.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SafetyCaseView } from "@/lib/safety-queue";

vi.mock("@/app/(app)/admin/safety/actions", () => ({ settleSafetyCaseAction: async () => ({}) }));
vi.mock("@/app/(app)/admin/reports/actions", () => ({ settleReportAction: async () => ({}) }));

const { SafetyView } = await import("@/app/(app)/admin/safety/safety-view");

const REPORT: SafetyCaseView = {
    id: "c1",
    kind: "user",
    status: "resolved",
    reason: "spam",
    note: "",
    outcome: "",
    subject: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    reporter: { id: "u2", name: "Alan Turing" },
    handledBy: { id: "u3", name: "Grace Hopper" },
    handledAt: null,
    createdAt: "2026-01-02T10:00:00.000Z",
    stillLocked: false
};

const LOCKDOWN: SafetyCaseView = {
    ...REPORT,
    id: "c2",
    kind: "lockdown",
    status: "open",
    reason: "",
    reporter: null,
    handledBy: null,
    stillLocked: true
};

function draw(cases: SafetyCaseView[], locale: "en-US" | "es-ES") {
    return renderToStaticMarkup(withMessages(<SafetyView cases={cases} reports={[]} status="all" />, locale));
}

describe("the safety queue", () => {
    it("reads as it always did in English", () => {
        const markup = draw([REPORT, { ...REPORT, id: "c3", handledBy: null, outcome: "Warned them" }], "en-US");
        expect(markup).toContain("Reported account");
        expect(markup).toContain("Spam or scams");
        expect(markup).toContain("Grace Hopper settled it.");
        expect(markup).toContain("Settled: Warned them");
        expect(markup).toContain("Everything");
    });

    it("draws a report and a lockdown in Spanish", () => {
        const markup = draw([REPORT, LOCKDOWN], "es-ES");
        expect(markup).toContain("Cuenta denunciada");
        expect(markup).toContain("Spam o estafas");
        expect(markup).toContain("Grace Hopper lo resolvió.");
        expect(markup).toContain("Cuenta bloqueada");
        expect(markup).toContain("Sigue bloqueada");
        expect(markup).toContain("Lo abrió la propia cuenta - ");
        expect(markup).toContain("Revisado");
        expect(markup).not.toContain("Reported account");
        expect(markup).not.toContain("settled it");
    });
});

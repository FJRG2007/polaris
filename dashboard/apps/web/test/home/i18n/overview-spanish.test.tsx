/**
 * The Overview's cards, drawn in Spanish.
 *
 * The counts are the part a translation breaks without anybody noticing: the
 * big number is one element and the sentence it belongs to another, so the
 * sentence has to agree with a number it does not contain.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/relative-time", () => ({ RelativeTime: ({ iso }: { iso: string }) => iso }));

const { ServicesWidget, TasksWidget } = await import("@/app/(app)/home/widgets/infrastructure");

describe("the services card in Spanish", () => {
    it("agrees the sentence with the count", () => {
        const one = renderToStaticMarkup(
            withMessages(<ServicesWidget data={{ running: 1, total: 1, rows: [] }} />, "es-ES")
        );
        const many = renderToStaticMarkup(
            withMessages(<ServicesWidget data={{ running: 2, total: 3, rows: [] }} />, "es-ES")
        );
        expect(one).toContain("de 1 servicio en marcha");
        expect(many).toContain("de 3 servicios en marcha");
    });

    it("reads as it did in English", () => {
        const markup = renderToStaticMarkup(withMessages(<ServicesWidget data={{ running: 2, total: 3, rows: [] }} />));
        expect(markup).toContain(" of 3 services running");
    });

    it("says there is nothing yet in Spanish", () => {
        const markup = renderToStaticMarkup(
            withMessages(<ServicesWidget data={{ running: 0, total: 0, rows: [] }} />, "es-ES")
        );
        expect(markup).toContain("Todavía no hay nada desplegado.");
        expect(markup).toContain("Desplegar algo");
    });
});

describe("the work card in Spanish", () => {
    it("counts what is assigned, late and due", () => {
        const markup = renderToStaticMarkup(
            withMessages(<TasksWidget data={{ assigned: 4, overdue: 1, dueToday: 2, rows: [] }} />, "es-ES")
        );
        expect(markup).toContain("asignadas");
        expect(markup).toContain("1 atrasada");
        expect(markup).toContain("2 vencen hoy");
    });
});

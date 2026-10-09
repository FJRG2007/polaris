/** The documents a small team keeps: plans, a budget, a deck, a diagram. */

import type { OfficeKind } from "@polaris/core";
import { TEAM, VIEWER, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { OfficeDocumentView } from "@/lib/office/documents";

interface Draft {
    readonly kind: OfficeKind;
    readonly title: [string, string];
    readonly excerpt: [string, string];
    readonly by: string;
    readonly minutes: number;
    readonly starred?: boolean;
    readonly shared?: boolean;
}

const DRAFTS: readonly Draft[] = [
    {
        kind: "doc",
        title: ["Launch plan", "Plan de lanzamiento"],
        excerpt: ["Goals, owners and the order things ship in on Thursday.", "Objetivos, responsables y el orden de publicación del jueves."],
        by: VIEWER.name,
        minutes: 18,
        starred: true
    },
    {
        kind: "sheet",
        title: ["Budget 2026", "Presupuesto 2026"],
        excerpt: ["Hosting, tools and travel by quarter.", "Alojamiento, herramientas y viajes por trimestre."],
        by: TEAM.sam.name,
        minutes: 64,
        shared: true
    },
    {
        kind: "slides",
        title: ["Q1 review", "Revisión del T1"],
        excerpt: ["What we shipped, what we learned, what is next.", "Qué publicamos, qué aprendimos y qué viene."],
        by: TEAM.ana.name,
        minutes: 60 * 5
    },
    {
        kind: "diagram",
        title: ["Checkout flow", "Flujo de pago"],
        excerpt: ["From cart to confirmation, with the new address step.", "Del carrito a la confirmación, con el nuevo paso de dirección."],
        by: TEAM.lena.name,
        minutes: 60 * 22,
        shared: true
    },
    {
        kind: "doc",
        title: ["Interview notes", "Notas de entrevistas"],
        excerpt: ["Five customer calls, grouped by what they asked for.", "Cinco llamadas con clientes, agrupadas por lo que pidieron."],
        by: TEAM.ana.name,
        minutes: 60 * 26
    },
    {
        kind: "comparison",
        title: ["Payment providers", "Proveedores de pago"],
        excerpt: ["Fees, payout times and countries, side by side.", "Comisiones, plazos de pago y países, uno al lado del otro."],
        by: TEAM.kenji.name,
        minutes: 60 * 49,
        starred: true
    },
    {
        kind: "sheet",
        title: ["Hiring pipeline", "Proceso de contratación"],
        excerpt: ["Candidates by stage and the next step for each.", "Candidatos por fase y el siguiente paso de cada uno."],
        by: VIEWER.name,
        minutes: 60 * 74
    },
    {
        kind: "doc",
        title: ["Onboarding guide", "Guía de bienvenida"],
        excerpt: ["Everything a new teammate needs in the first week.", "Todo lo que necesita alguien nuevo la primera semana."],
        by: TEAM.priya.name,
        minutes: 60 * 120
    }
];

export function officeDocuments(ctx: SceneContext): OfficeDocumentView[] {
    return DRAFTS.map((draft, index) => ({
        id: id("office-document", index + 1),
        kind: draft.kind,
        title: ctx.say(...draft.title),
        excerpt: ctx.say(...draft.excerpt),
        orgId: null,
        orgName: null,
        archived: false,
        trashed: false,
        editedBy: draft.by,
        editedAt: ago(ctx.now, draft.minutes),
        createdAt: ago(ctx.now, draft.minutes + 60 * 24 * 12),
        openedAt: ago(ctx.now, draft.minutes + 5),
        starred: draft.starred ?? false,
        shared: draft.shared ?? false
    }));
}

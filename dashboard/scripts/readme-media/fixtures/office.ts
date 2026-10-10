/** The documents a small team keeps: plans, a budget, a deck, a diagram. */

import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import type { OfficeKind } from "@polaris/core";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { OFFICE_FIELD } from "@/lib/office/content";
import { documentExtensions } from "@/components/rich-text/document-schema";
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
        excerpt: [
            "Goals, owners and the order things ship in on Thursday.",
            "Objetivos, responsables y el orden de publicación del jueves."
        ],
        by: VIEWER.name,
        minutes: 18,
        starred: true
    },
    {
        kind: "sheet",
        title: ["Budget 2026", "Presupuesto 2026"],
        excerpt: [
            "Hosting, tools and travel by quarter.",
            "Alojamiento, herramientas y viajes por trimestre."
        ],
        by: TEAM.sam.name,
        minutes: 64,
        shared: true
    },
    {
        kind: "slides",
        title: ["Q1 review", "Revisión del T1"],
        excerpt: [
            "What we shipped, what we learned, what is next.",
            "Qué publicamos, qué aprendimos y qué viene."
        ],
        by: TEAM.ana.name,
        minutes: 60 * 5
    },
    {
        kind: "diagram",
        title: ["Checkout flow", "Flujo de pago"],
        excerpt: [
            "From cart to confirmation, with the new address step.",
            "Del carrito a la confirmación, con el nuevo paso de dirección."
        ],
        by: TEAM.lena.name,
        minutes: 60 * 22,
        shared: true
    },
    {
        kind: "doc",
        title: ["Interview notes", "Notas de entrevistas"],
        excerpt: [
            "Five customer calls, grouped by what they asked for.",
            "Cinco llamadas con clientes, agrupadas por lo que pidieron."
        ],
        by: TEAM.ana.name,
        minutes: 60 * 26
    },
    {
        kind: "comparison",
        title: ["Payment providers", "Proveedores de pago"],
        excerpt: [
            "Fees, payout times and countries, side by side.",
            "Comisiones, plazos de pago y países, uno al lado del otro."
        ],
        by: TEAM.kenji.name,
        minutes: 60 * 49,
        starred: true
    },
    {
        kind: "sheet",
        title: ["Hiring pipeline", "Proceso de contratación"],
        excerpt: [
            "Candidates by stage and the next step for each.",
            "Candidatos por fase y el siguiente paso de cada uno."
        ],
        by: VIEWER.name,
        minutes: 60 * 74
    },
    {
        kind: "doc",
        title: ["Onboarding guide", "Guía de bienvenida"],
        excerpt: [
            "Everything a new teammate needs in the first week.",
            "Todo lo que necesita alguien nuevo la primera semana."
        ],
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

/** The document the editor scene opens: the first one on the shelf. */
export const OPEN_DOCUMENT_ID = id("office-document", 1);

type Node = Record<string, unknown>;
const text = (value: string, marks?: Node[]): Node => ({ type: "text", text: value, marks });
const paragraph = (...content: Node[]): Node => ({ type: "paragraph", content });
const heading = (level: number, value: string): Node => ({
    type: "heading",
    attrs: { level },
    content: [text(value)]
});
const task = (checked: boolean, value: string): Node => ({
    type: "taskItem",
    attrs: { checked },
    content: [paragraph(text(value))]
});
const cell = (type: "tableHeader" | "tableCell", value: string): Node => ({
    type,
    content: [paragraph(text(value))]
});

/**
 * The launch plan as the server keeps it: a Yjs update made from the editor's
 * own schema, which the editor opens exactly as it opens a stored one.
 */
export function launchPlanContent(ctx: SceneContext): number[] {
    const say = ctx.say;
    const bold = [{ type: "bold" }];
    const row = (type: "tableHeader" | "tableCell", ...values: string[]): Node => ({
        type: "tableRow",
        content: values.map((value) => cell(type, value))
    });
    const json = {
        type: "doc",
        content: [
            heading(1, say("Launch plan", "Plan de lanzamiento")),
            paragraph(
                text(say("Ships ", "Sale el ")),
                text(say("Thursday at 10:00", "jueves a las 10:00"), bold),
                text(
                    say(
                        ". The storefront goes first, the mobile apps follow once it is stable.",
                        ". Primero la tienda; las apps móviles, cuando esté estable."
                    )
                )
            ),
            heading(2, say("Before Thursday", "Antes del jueves")),
            {
                type: "taskList",
                content: [
                    task(true, say("Freeze the release branch", "Congelar la rama de la versión")),
                    task(true, say("Load test checkout", "Prueba de carga del pago")),
                    task(false, say("Update the status page", "Actualizar la página de estado")),
                    task(
                        false,
                        say("Brief support on the new flow", "Explicar el nuevo flujo a soporte")
                    )
                ]
            },
            heading(2, say("Who does what", "Quién hace qué")),
            {
                type: "table",
                content: [
                    row(
                        "tableHeader",
                        say("Part", "Parte"),
                        say("Owner", "Responsable"),
                        say("When", "Cuándo")
                    ),
                    row("tableCell", say("Storefront", "Tienda"), TEAM.kenji.name, "10:00"),
                    row("tableCell", say("Payments", "Pagos"), TEAM.sam.name, "10:30"),
                    row("tableCell", say("Announcement", "Anuncio"), TEAM.priya.name, "11:00")
                ]
            }
        ]
    };
    const doc = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
        getSchema(documentExtensions("")),
        json,
        doc.getXmlFragment(OFFICE_FIELD)
    );
    return Array.from(Y.encodeStateAsUpdate(doc));
}

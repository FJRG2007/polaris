/** What a small team writes down: the viewer's own notes and a shared notebook. */

import type { ShelfData } from "@/app/(app)/notes/note-tree";
import type { NoteView } from "@/lib/notes/note-service";
import { ORG, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";

/** The note the picture has open. */
const OPEN_NOTE_ID = id("note", 1);

const NOTEBOOK_ID = id("notebook", 1);

interface Draft {
    readonly n: number;
    readonly title: [string, string];
    readonly excerpt: [string, string];
    readonly minutes: number;
    readonly pinned?: boolean;
    readonly parent?: number;
    readonly folder?: number;
}

const OWN: readonly Draft[] = [
    {
        n: 1,
        title: ["Launch checklist", "Lista de lanzamiento"],
        excerpt: [
            "Everything that has to be true by Thursday.",
            "Todo lo que tiene que estar listo el jueves."
        ],
        minutes: 6,
        pinned: true
    },
    {
        n: 2,
        title: ["1:1 with Ana", "1:1 con Ana"],
        excerpt: [
            "Hiring plan, the on-call rota, her trip in May.",
            "Plan de contratación, guardias, su viaje en mayo."
        ],
        minutes: 95,
        parent: 1
    },
    {
        n: 3,
        title: ["Reading list", "Lista de lectura"],
        excerpt: [
            "Three books and the two papers Sam sent.",
            "Tres libros y los dos artículos de Sam."
        ],
        minutes: 60 * 26
    },
    {
        n: 4,
        title: ["Ideas", "Ideas"],
        excerpt: [
            "A status page per customer, dark mode for mail.",
            "Una página de estado por cliente, modo oscuro."
        ],
        minutes: 60 * 50
    }
];

const TEAM: readonly Draft[] = [
    {
        n: 11,
        title: ["Weekly sync", "Reunión semanal"],
        excerpt: [
            "Agenda, decisions and who owns what.",
            "Orden del día, decisiones y responsables."
        ],
        minutes: 60 * 3,
        folder: 1
    },
    {
        n: 12,
        title: ["Retro - March", "Retro - marzo"],
        excerpt: [
            "What went well, what did not, what we change.",
            "Qué fue bien, qué no y qué cambiamos."
        ],
        minutes: 60 * 28,
        folder: 1
    },
    {
        n: 13,
        title: ["Onboarding", "Incorporación"],
        excerpt: [
            "Accounts, laptops and the first week.",
            "Cuentas, portátiles y la primera semana."
        ],
        minutes: 60 * 72
    }
];

function summaries(ctx: SceneContext, drafts: readonly Draft[]) {
    return drafts.map((draft) => ({
        id: id("note", draft.n),
        title: ctx.say(...draft.title),
        excerpt: ctx.say(...draft.excerpt),
        pinned: draft.pinned ?? false,
        parentId: draft.parent ? id("note", draft.parent) : null,
        folderId: draft.folder ? id("note-folder", draft.folder) : null,
        depth: draft.parent ? 1 : 0,
        hasChildren: drafts.some((other) => other.parent === draft.n),
        updatedAt: ago(ctx.now, draft.minutes)
    }));
}

/** The private shelf, then the team's notebook with one folder. */
export function noteShelves(ctx: SceneContext): ShelfData[] {
    return [
        { space: null, folders: [], notes: summaries(ctx, OWN) },
        {
            space: {
                id: NOTEBOOK_ID,
                name: ctx.say("Product team", "Equipo de producto"),
                icon: null,
                color: "#6366f1",
                visibility: "org",
                orgId: ORG.id,
                role: "owner"
            },
            folders: [
                {
                    id: id("note-folder", 1),
                    name: ctx.say("Meetings", "Reuniones"),
                    icon: null,
                    parentId: null,
                    order: 0
                }
            ],
            notes: summaries(ctx, TEAM)
        }
    ];
}

/** Written the way the editor writes it back, so opening the note saves nothing. */
const BODY = {
    en: `Everything that has to be true by **Thursday**, in the order it ships.

## Before the release

- [x] Freeze the branch and tag \`v2.4.0\`
- [x] Write the changelog
- [ ] Check the migration on a copy of last night's backup
- [ ] Update the status page

## On the day

1. Publish at 10:00, after the stand-up
2. Watch the error rate for an hour
3. Post in #announcements

> If anything looks wrong, roll back first and ask questions after.`,
    es: `Todo lo que tiene que estar listo el **jueves**, en el orden en que sale.

## Antes de publicar

- [x] Congelar la rama y etiquetar \`v2.4.0\`
- [x] Escribir el registro de cambios
- [ ] Probar la migración con la copia de anoche
- [ ] Actualizar la página de estado

## El día

1. Publicar a las 10:00, después de la reunión
2. Vigilar los errores durante una hora
3. Avisar en #anuncios

> Si algo va mal, primero se vuelve atrás y luego se pregunta.`
};

export function openNote(ctx: SceneContext): NoteView {
    return {
        id: OPEN_NOTE_ID,
        title: ctx.say(...OWN[0]!.title),
        body: ctx.locale === "es-ES" ? BODY.es : BODY.en,
        pinned: true,
        parentId: null,
        spaceId: null,
        folderId: null,
        updatedAt: ago(ctx.now, 6)
    };
}

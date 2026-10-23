/** The automations a small team keeps running, a folder of them and how each last went. */

import { ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { FolderRow } from "@/lib/automations/organize";
import type { AutomationRow } from "@/lib/automations/service";

interface Draft {
    readonly name: [string, string];
    readonly description: [string, string];
    readonly mode: string;
    /** Minutes since it last ran, or null for one that never has. */
    readonly ran: number | null;
    readonly status: string | null;
    readonly enabled?: boolean;
    readonly folder?: number;
    readonly tags?: readonly string[];
}

const DRAFTS: readonly Draft[] = [
    {
        name: ["New order to #sales", "Pedido nuevo a #ventas"],
        description: [
            "Posts every paid order in the sales channel.",
            "Publica cada pedido pagado en el canal de ventas."
        ],
        mode: "queued",
        ran: 4,
        status: "succeeded",
        folder: 1,
        tags: ["shop"]
    },
    {
        name: ["Invoice to Drive", "Factura a Drive"],
        description: [
            "Files every invoice that arrives by mail.",
            "Guarda cada factura que llega por correo."
        ],
        mode: "parallel",
        ran: 60 * 3,
        status: "succeeded",
        folder: 1
    },
    {
        name: ["Nightly backup check", "Revisión de la copia nocturna"],
        description: [
            "Opens a task when last night's backup is missing.",
            "Abre una tarea si falta la copia de anoche."
        ],
        mode: "single",
        ran: 60 * 9,
        status: "succeeded",
        tags: ["ops"]
    },
    {
        name: ["Server down alert", "Aviso de servidor caído"],
        description: [
            "Rings the on-call person when a server stops reporting.",
            "Avisa a la guardia si un servidor deja de responder."
        ],
        mode: "single",
        ran: 38,
        status: "failed",
        tags: ["ops"]
    },
    {
        name: ["Weekly report", "Informe semanal"],
        description: ["Sends Monday's numbers to the team.", "Envía las cifras del lunes al equipo."],
        mode: "single",
        ran: 60 * 24 * 2,
        status: "succeeded"
    },
    {
        name: ["Welcome new members", "Bienvenida a nuevos miembros"],
        description: [
            "A direct message and a checklist on the first day.",
            "Un mensaje directo y una lista el primer día."
        ],
        mode: "single",
        ran: null,
        status: null,
        enabled: false
    }
];

export function automationFolders(ctx: SceneContext): FolderRow[] {
    return [{ id: id("automation-folder", 1), name: ctx.say("Shop", "Tienda") }];
}

export function automationRows(ctx: SceneContext): AutomationRow[] {
    return DRAFTS.map((draft, n) => ({
        id: id("automation", n + 1),
        name: ctx.say(...draft.name),
        description: ctx.say(...draft.description),
        enabled: draft.enabled ?? true,
        published: true,
        mode: draft.mode,
        lastRunAt: draft.ran == null ? null : ago(ctx.now, draft.ran),
        lastStatus: draft.status,
        updatedAt: ago(ctx.now, (draft.ran ?? 60) + 120),
        folderId: draft.folder ? id("automation-folder", draft.folder) : null,
        tags: draft.tags ?? [],
        runnable: draft.enabled ?? true
    }));
}

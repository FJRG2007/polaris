/** Polar's side of a small team's day: the chats in its sidebar and the one open. */

import { ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { PolarThreadRow } from "@/lib/polar/shared";

/** One provider this Polaris pays for, with the model the catalogue gives it
 *  (`lib/integrations/model-providers.ts`). */
export const POLAR_PROVIDERS = [
    {
        provider: "mistral",
        name: "Mistral",
        payers: ["instance"],
        models: [{ provider: "mistral", model: "mistral-medium-2508", name: "Mistral Medium", reasoning: false }]
    }
];

const CHOICE = {
    kind: "language",
    provider: "mistral",
    model: "mistral-medium-2508",
    intelligence: "balanced",
    payer: "instance"
} as const;

/** The chat the picture has open. */
export const OPEN_THREAD_ID = id("polar-thread", 1);

const TITLES: readonly [string, string, number][] = [
    ["Release notes for v2.4", "Notas de la versión 2.4", 3],
    ["Why is orion so busy?", "¿Por qué orion va tan cargado?", 60 * 2],
    ["Reply to the Lisbon venue", "Respuesta al local de Lisboa", 60 * 20],
    ["Q1 numbers in a table", "Cifras del T1 en una tabla", 60 * 26],
    ["Onboarding checklist", "Lista de incorporación", 60 * 49]
];

export function polarThreads(ctx: SceneContext): PolarThreadRow[] {
    return TITLES.map(([en, es, minutes], n) => ({
        id: id("polar-thread", n + 1),
        title: ctx.say(en, es),
        updatedAt: ago(ctx.now, minutes),
        pinnedAt: null,
        archivedAt: null,
        projectId: null
    }));
}

const QUESTION = {
    en: "Write the release notes for v2.4 from this week's merged changes. Keep it short.",
    es: "Escribe las notas de la versión 2.4 con los cambios de esta semana. Que sean breves."
};

const ANSWER = {
    en: `Here is a draft for **v2.4**:

### New
- Notes can be shared with a whole notebook
- Watch shows the last hour of CPU on every card

### Fixed
- Mail no longer loses a draft when the tab closes
- Long channel names are cut cleanly on phones

Want me to post it in #announcements?`,
    es: `Aquí tienes un borrador de la **2.4**:

### Novedades
- Las notas se comparten con todo un cuaderno
- Watch muestra la última hora de CPU en cada tarjeta

### Arreglos
- El correo ya no pierde un borrador al cerrar la pestaña
- Los nombres largos de canal se cortan bien en el móvil

¿Lo publico en #anuncios?`
};

/** The open chat as the server stores it: a question and its answer. */
export function polarThread(ctx: SceneContext) {
    const say = (pair: { en: string; es: string }) => (ctx.locale === "es-ES" ? pair.es : pair.en);
    const question = id("polar-message", 1);
    return {
        id: OPEN_THREAD_ID,
        projectId: null,
        queue: [],
        choice: CHOICE,
        messages: [
            { id: question, role: "user", parentId: null, parts: [{ type: "text", text: say(QUESTION) }] },
            {
                id: id("polar-message", 2),
                role: "assistant",
                parentId: question,
                parts: [{ type: "text", text: say(ANSWER) }]
            }
        ]
    };
}

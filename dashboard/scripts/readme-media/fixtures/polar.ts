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
        models: [
            {
                provider: "mistral",
                model: "mistral-medium-2508",
                name: "Mistral Medium",
                reasoning: false
            }
        ]
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

/** The product page the extension's side panel is opened beside: an invented shop. */
export const SHOP = {
    url: "https://shop.example/p/trailhead-28l",
    store: "Example Outfitters",
    product: { en: "Trailhead 28L hiking backpack", es: "Mochila de senderismo Trailhead 28L" },
    price: "89,00 €",
    rating: 4.4,
    reviews: 1286,
    points: {
        en: [
            "28 L main compartment",
            'Padded sleeve for laptops up to 15.6"',
            "Rain cover included",
            "1.1 kg"
        ],
        es: [
            "Compartimento principal de 28 L",
            'Funda acolchada para portátiles de hasta 15,6"',
            "Funda para lluvia incluida",
            "1,1 kg"
        ]
    },
    quotes: {
        en: [
            ["Comfortable on a full day out, the hip belt takes the weight.", 5],
            ["My 16-inch laptop does not fit the sleeve.", 2],
            ["Zips feel cheap but held up for a year.", 4]
        ],
        es: [
            ["Cómoda en un día entero, el cinturón reparte el peso.", 5],
            ["Mi portátil de 16 pulgadas no cabe en la funda.", 2],
            ["Las cremalleras parecen flojas pero aguantan un año.", 4]
        ]
    }
} as const;

const SHOP_QUESTION = {
    en: "Summarise the reviews on this page. Will my 16-inch laptop fit?",
    es: "Resume las opiniones de esta página. ¿Cabe mi portátil de 16 pulgadas?"
};

const SHOP_ANSWER = {
    en: `From the **1,286 reviews** (4.4 of 5):

- **Liked:** comfortable all day, the hip belt carries the weight, the rain cover
- **Disliked:** zips feel light, side pockets are shallow

**Your laptop:** the sleeve takes up to **15.6"**, and several reviewers say a
16-inch one does not fit. Carry it in the main compartment, or look at a 30 L model.`,
    es: `De las **1286 opiniones** (4,4 de 5):

- **Gusta:** cómoda todo el día, el cinturón reparte el peso, la funda para lluvia
- **No gusta:** cremalleras flojas, bolsillos laterales poco profundos

**Tu portátil:** la funda admite hasta **15,6"** y varios dicen que uno de 16
pulgadas no cabe. Llévalo en el compartimento principal o mira un modelo de 30 L.`
};

/** Asked once the reviews are read: Polar then works the page itself. */
const SHOP_ACT = {
    en: "Pick the 30 L size and add it to my basket.",
    es: "Elige la talla de 30 L y añádela a la cesta."
};

const SHOP_ACTED = {
    en: "Done: the **30 L** size is picked and in your basket, which now shows 1 item.",
    es: "Hecho: la talla de **30 L** está elegida y en tu cesta, que ya muestra 1 artículo."
};

/** The size the side panel picks on the page, and the button it presses. */
export const SHOP_SIZES = ["28 L", "30 L"] as const;

/**
 * How far a chat has got in the animation: asked, answering, answered - and,
 * in the side panel only, acting on the page and done with it.
 */
export type PolarStage = "asked" | "answering" | "answered" | "acting" | "acted";

/** The first lines of an answer, the way it reads while it is still arriving. */
function partOf(text: string): string {
    const lines = text.split("\n");
    return lines.slice(0, Math.ceil(lines.length / 2)).join("\n");
}

/**
 * The open chat as the server stores it: a question and, once Polar has got
 * that far, its answer. `shop` is the side panel's chat about the product page.
 */
export function polarThread(ctx: SceneContext, stage: PolarStage = "answered", shop = false) {
    const say = (pair: { en: string; es: string }) => (ctx.locale === "es-ES" ? pair.es : pair.en);
    const question = id("polar-message", shop ? 3 : 1);
    const answer = say(shop ? SHOP_ANSWER : ANSWER);
    return {
        id: OPEN_THREAD_ID,
        projectId: null,
        queue: [],
        choice: CHOICE,
        messages: [
            {
                id: question,
                role: "user",
                parentId: null,
                parts: [{ type: "text", text: say(shop ? SHOP_QUESTION : QUESTION) }]
            },
            ...(stage === "asked"
                ? []
                : [
                      {
                          id: id("polar-message", shop ? 4 : 2),
                          role: "assistant",
                          parentId: question,
                          parts: [
                              {
                                  type: "text",
                                  text: stage === "answering" ? partOf(answer) : answer
                              }
                          ]
                      }
                  ]),
            ...(shop && (stage === "acting" || stage === "acted")
                ? actOnPage(ctx, stage === "acted")
                : [])
        ]
    };
}

/** Polar's browser tool, as a stored step: one press on the page beside the panel. */
function press(n: number, element: string, done: boolean) {
    return {
        type: "tool-browser",
        toolCallId: id("polar-call", n),
        state: done ? "output-available" : "input-available",
        input: { action: "click", site: new URL(SHOP.url).host, element },
        ...(done ? { output: { ok: true } } : {})
    };
}

/** The side panel asked to work the page: the size picked, then the basket. */
function actOnPage(ctx: SceneContext, done: boolean) {
    const ask = id("polar-message", 5);
    const basket = ctx.say("Add to basket", "Añadir a la cesta");
    return [
        { id: ask, role: "user", parentId: id("polar-message", 4), parts: [{ type: "text", text: ctx.say(SHOP_ACT.en, SHOP_ACT.es) }] },
        {
            id: id("polar-message", 6),
            role: "assistant",
            parentId: ask,
            parts: [
                press(1, SHOP_SIZES[1], true),
                press(2, basket, done),
                ...(done ? [{ type: "text", text: ctx.say(SHOP_ACTED.en, SHOP_ACTED.es) }] : [])
            ]
        }
    ];
}

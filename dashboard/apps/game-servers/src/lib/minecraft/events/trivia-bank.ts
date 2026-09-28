/**
 * The questions and words a trivia event draws from when the operator wrote none
 * of their own - about Minecraft, answerable by anybody who plays it, and with
 * every reasonable way of writing the answer accepted.
 *
 * Answers are compared after `normalizeAnswer`, so case, accents, spaces and
 * punctuation never decide a round.
 */

import type { Language, TriviaQuestion } from "./catalog";

export const QUESTIONS: Readonly<Record<Language, readonly TriviaQuestion[]>> = {
    en: [
        {
            question: "How many blocks of obsidian make the smallest Nether portal frame?",
            answers: ["10", "ten"]
        },
        {
            question: "What do you need to mine obsidian?",
            answers: ["diamond pickaxe", "netherite pickaxe", "diamond pick"]
        },
        {
            question: "Which mob drops gunpowder when killed and explodes when near you?",
            answers: ["creeper"]
        },
        {
            question: "What item do you throw to find a stronghold?",
            answers: ["eye of ender", "ender eye", "eyes of ender"]
        },
        { question: "How many ender eyes fill a complete End portal?", answers: ["12", "twelve"] },
        {
            question: "What is the name of the boss in the End?",
            answers: ["ender dragon", "the ender dragon", "dragon"]
        },
        {
            question: "Which ore is only found in mountain biomes in the Overworld?",
            answers: ["emerald", "emerald ore"]
        },
        { question: "What do you feed a wolf to tame it?", answers: ["bone", "bones"] },
        { question: "What block do you need to brew potions?", answers: ["brewing stand"] },
        {
            question: "What is the maximum stack size of most items?",
            answers: ["64", "sixty four", "sixty-four"]
        },
        {
            question: "Which mob can pick up blocks and teleport?",
            answers: ["enderman", "endermen"]
        },
        {
            question:
                "What do you combine with a diamond tool at a smithing table to make netherite?",
            answers: ["netherite ingot", "netherite ingots"]
        },
        { question: "How many wool blocks does it take to craft a bed?", answers: ["3", "three"] },
        {
            question: "What does a piglin want in exchange for bartering?",
            answers: ["gold", "gold ingot", "gold ingots"]
        },
        {
            question: "Which fuel lasts the longest in a furnace?",
            answers: ["lava bucket", "bucket of lava", "lava"]
        },
        {
            question: "What mob do you need to kill to get a trident?",
            answers: ["drowned", "a drowned"]
        },
        { question: "What do you use to shear a sheep?", answers: ["shears"] },
        {
            question: "What item lets you breathe underwater for longer when worn on the head?",
            answers: ["turtle shell", "turtle helmet"]
        },
        {
            question: "How many ingots make a full set of iron armour?",
            answers: ["24", "twenty four", "twenty-four"]
        },
        {
            question: "What is the rarest ore in the Nether?",
            answers: ["ancient debris", "debris"]
        },
        {
            question: "Which boss is summoned with soul sand and wither skeleton skulls?",
            answers: ["wither", "the wither"]
        },
        { question: "What tool breaks wool the fastest?", answers: ["shears"] },
        { question: "What do you need to catch a fish?", answers: ["fishing rod", "rod"] },
        {
            question: "Which dimension has no day and night cycle and floating islands?",
            answers: ["the end", "end"]
        },
        {
            question: "What block makes a beacon work when placed beneath it in a pyramid?",
            answers: [
                "iron block",
                "gold block",
                "diamond block",
                "emerald block",
                "netherite block"
            ]
        },
        { question: "What do villagers use as currency?", answers: ["emerald", "emeralds"] },
        {
            question: "Which mob turns into a witch when struck by lightning?",
            answers: ["villager", "villagers"]
        },
        { question: "What block do you right-click to skip the night?", answers: ["bed"] },
        {
            question: "Which item is dropped by blazes and powers brewing stands?",
            answers: ["blaze rod", "blaze rods", "blaze powder"]
        },
        {
            question: "What is the name of the hostile mob that only spawns in the deep dark?",
            answers: ["warden", "the warden"]
        },
        { question: "How many hearts does a player have at full health?", answers: ["10", "ten"] },
        {
            question: "What food restores the most hunger?",
            answers: ["rabbit stew", "suspicious stew", "cake", "golden carrot"]
        },
        {
            question: "What block is crafted from 9 diamonds?",
            answers: ["diamond block", "block of diamond"]
        },
        {
            question: "What does a totem of undying do?",
            answers: ["saves you from death", "prevents death", "revives you", "saves you"]
        },
        { question: "Which mob drops ender pearls?", answers: ["enderman", "endermen"] },
        {
            question:
                "What is the name of the flying mob that spawns when you do not sleep for days?",
            answers: ["phantom", "phantoms"]
        },
        {
            question: "What do you use to tame a horse besides riding it?",
            answers: ["golden apple", "golden carrot", "sugar", "apple", "wheat", "hay bale"]
        },
        {
            question: "What block grows on sand next to water and can be crafted into sugar?",
            answers: ["sugar cane", "sugarcane"]
        },
        {
            question:
                "For every block travelled in the Nether, how many do you cover in the Overworld?",
            answers: ["8", "eight"]
        },
        {
            question: "What material are the strongest tools in the game made of?",
            answers: ["netherite"]
        }
    ],
    es: [
        {
            question:
                "¿Cuántos bloques de obsidiana tiene el marco de portal al Nether más pequeño?",
            answers: ["10", "diez"]
        },
        {
            question: "¿Qué necesitas para picar obsidiana?",
            answers: ["pico de diamante", "pico de netherita"]
        },
        { question: "¿Qué mob explota cerca de ti y suelta pólvora?", answers: ["creeper"] },
        {
            question: "¿Qué objeto lanzas para encontrar una fortaleza?",
            answers: ["ojo de ender", "ojos de ender", "ojo del end"]
        },
        {
            question: "¿Cuántos ojos de ender llenan un portal del End completo?",
            answers: ["12", "doce"]
        },
        {
            question: "¿Cómo se llama el jefe del End?",
            answers: ["dragon del end", "ender dragon", "dragon", "el dragon del end"]
        },
        {
            question: "¿Qué mena solo aparece en los biomas de montaña del mundo normal?",
            answers: ["esmeralda", "mena de esmeralda"]
        },
        { question: "¿Qué le das a un lobo para domesticarlo?", answers: ["hueso", "huesos"] },
        {
            question: "¿Qué bloque necesitas para hacer pociones?",
            answers: ["soporte para pociones", "destilador"]
        },
        {
            question: "¿Cuál es el tamaño máximo de pila de la mayoría de objetos?",
            answers: ["64", "sesenta y cuatro"]
        },
        {
            question: "¿Qué mob coge bloques y se teletransporta?",
            answers: ["enderman", "endermans"]
        },
        {
            question:
                "¿Qué combinas con una herramienta de diamante en la mesa de herrería para hacerla de netherita?",
            answers: ["lingote de netherita", "lingotes de netherita"]
        },
        {
            question: "¿Cuántos bloques de lana hacen falta para fabricar una cama?",
            answers: ["3", "tres"]
        },
        {
            question: "¿Qué quieren los piglins a cambio de hacer trueques?",
            answers: ["oro", "lingote de oro", "lingotes de oro"]
        },
        { question: "¿Qué combustible dura más en un horno?", answers: ["cubo de lava", "lava"] },
        {
            question: "¿Qué mob hay que matar para conseguir un tridente?",
            answers: ["ahogado", "ahogados", "drowned"]
        },
        { question: "¿Con qué esquilas a una oveja?", answers: ["tijeras"] },
        {
            question: "¿Qué casco te deja respirar más tiempo bajo el agua?",
            answers: ["caparazon de tortuga", "casco de tortuga"]
        },
        {
            question: "¿Cuántos lingotes hacen una armadura de hierro completa?",
            answers: ["24", "veinticuatro"]
        },
        {
            question: "¿Cuál es la mena más rara del Nether?",
            answers: ["escombros ancestrales", "restos ancestrales", "ancient debris"]
        },
        {
            question: "¿Qué jefe se invoca con arena de almas y cráneos de esqueleto wither?",
            answers: ["wither", "el wither"]
        },
        { question: "¿Con qué pescas un pez?", answers: ["caña de pescar", "caña"] },
        {
            question: "¿Qué dimensión no tiene día ni noche y tiene islas flotantes?",
            answers: ["el end", "end"]
        },
        { question: "¿Qué usan los aldeanos como moneda?", answers: ["esmeralda", "esmeraldas"] },
        {
            question: "¿Qué mob se convierte en bruja si le cae un rayo?",
            answers: ["aldeano", "aldeanos"]
        },
        { question: "¿Qué bloque usas para saltarte la noche?", answers: ["cama"] },
        {
            question: "¿Qué sueltan los blazes que sirve para el soporte de pociones?",
            answers: ["vara de blaze", "varas de blaze", "polvo de blaze"]
        },
        {
            question: "¿Cómo se llama el mob hostil que aparece en la oscuridad profunda?",
            answers: ["warden", "el warden", "guardian"]
        },
        {
            question: "¿Cuántos corazones tiene un jugador con la vida llena?",
            answers: ["10", "diez"]
        },
        { question: "¿Qué bloque se fabrica con 9 diamantes?", answers: ["bloque de diamante"] },
        {
            question: "¿Qué hace un tótem de la inmortalidad?",
            answers: ["te salva de morir", "evita la muerte", "te revive", "te salva"]
        },
        { question: "¿Qué mob suelta perlas de ender?", answers: ["enderman", "endermans"] },
        {
            question: "¿Cómo se llama el mob volador que aparece si no duermes en días?",
            answers: ["phantom", "phantoms", "fantasma", "fantasmas"]
        },
        {
            question: "¿Qué planta crece en la arena junto al agua y da azúcar?",
            answers: ["caña de azucar", "cañas de azucar"]
        },
        {
            question:
                "Por cada bloque que recorres en el Nether, ¿cuántos recorres en el mundo normal?",
            answers: ["8", "ocho"]
        },
        {
            question: "¿De qué material son las herramientas más fuertes del juego?",
            answers: ["netherita"]
        }
    ]
};

/** Words for a scramble round: Minecraft things, long enough to be a puzzle. */
export const WORDS: Readonly<Record<Language, readonly string[]>> = {
    en: [
        "creeper",
        "diamond",
        "obsidian",
        "enderman",
        "redstone",
        "villager",
        "skeleton",
        "netherite",
        "furnace",
        "crafting",
        "pickaxe",
        "emerald",
        "beacon",
        "elytra",
        "trident",
        "blaze",
        "witch",
        "piglin",
        "stronghold",
        "portal",
        "potion",
        "anvil",
        "shulker",
        "phantom",
        "lantern",
        "compass",
        "saddle",
        "spyglass",
        "warden",
        "amethyst",
        "copper",
        "bamboo",
        "cactus",
        "pumpkin",
        "melon",
        "ravager",
        "pillager",
        "totem",
        "lectern",
        "observer"
    ],
    es: [
        "creeper",
        "diamante",
        "obsidiana",
        "enderman",
        "aldeano",
        "esqueleto",
        "netherita",
        "horno",
        "pico",
        "esmeralda",
        "faro",
        "tridente",
        "bruja",
        "fortaleza",
        "portal",
        "pocion",
        "yunque",
        "fantasma",
        "farolillo",
        "brujula",
        "montura",
        "catalejo",
        "amatista",
        "cobre",
        "bambu",
        "cactus",
        "calabaza",
        "sandia",
        "totem",
        "atril",
        "observador",
        "antorcha",
        "espada",
        "escudo",
        "ballesta",
        "arco",
        "flecha",
        "cofre",
        "tolva",
        "piston"
    ]
};

/** An answer as it is compared: lowercased, accents gone, only letters, digits
 *  and single spaces left. */
export function normalizeAnswer(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9ñ ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Whether something said in the chat answers the question. */
export function answers(said: string, accepted: readonly string[]): boolean {
    const typed = normalizeAnswer(said);
    if (!typed) return false;
    return accepted.some((answer) => normalizeAnswer(answer) === typed);
}

/**
 * A word with its letters shuffled, never left as it was.
 *
 * `random` is passed in so a test can pin the shuffle.
 */
export function scramble(word: string, random: () => number = Math.random): string {
    const letters = [...word.toUpperCase()];
    if (new Set(letters).size < 2) return letters.join("");
    for (let attempt = 0; attempt < 20; attempt += 1) {
        for (let index = letters.length - 1; index > 0; index -= 1) {
            const other = Math.floor(random() * (index + 1));
            [letters[index], letters[other]] = [letters[other] as string, letters[index] as string];
        }
        if (letters.join("") !== word.toUpperCase()) break;
    }
    return letters.join("");
}

/**
 * A repeatable stream of numbers from a word - the event's id - so the order the
 * questions come in is the same after Polaris restarts mid-game as before it.
 */
export function seeded(seed: string): () => number {
    let state = 2166136261;
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** A copy of a list in a random order. */
export function shuffled<T>(list: readonly T[], random: () => number): T[] {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
    }
    return copy;
}

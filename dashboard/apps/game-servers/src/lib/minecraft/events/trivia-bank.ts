/**
 * The questions and words a trivia event draws from when the operator wrote none
 * of their own - about Minecraft, answerable by anybody who plays it, and with
 * every reasonable way of writing the answer accepted.
 *
 * Answers are compared after `normalizeAnswer`, so case, accents, spaces and
 * punctuation never decide a round.
 */

import bank from "./trivia-questions.json";
import type { Language, TriviaQuestion } from "./catalog";

/** What a bank question is about - every one of them is about Minecraft. */
export const CATEGORIES = [
    "blocks",
    "mobs",
    "crafting",
    "world",
    "redstone",
    "enchanting",
    "versions",
    "advancements",
    "mechanics"
] as const;

/** One question of the bank, in every language, and what it is about. */
export interface BankQuestion {
    /** Stable: kept in a server's list of what was asked lately. */
    readonly id: string;
    readonly category: (typeof CATEGORIES)[number];
    /** The Minecraft Wiki page the answer was checked against. */
    readonly source: string;
    readonly en: TriviaQuestion;
    readonly es: TriviaQuestion;
}

/**
 * Every built-in question, kept as data (`trivia-questions.json`): Minecraft
 * only - its blocks, mobs, crafting, world, redstone, enchanting and brewing,
 * versions, advancements and mechanics, each answer checked on the Minecraft
 * Wiki for Java Edition 1.21. Each is the same question in every language, so
 * players reading different languages are asked the same thing in the same
 * round, and the game's own names are accepted in either language. Those
 * answered `true` or `false` (`verdadero`, `falso`) are a sentence to judge,
 * asked as a true-or-false round (`truthOf`).
 */
export const BANK: readonly BankQuestion[] = bank as BankQuestion[];

/** The bank in one language, in its own order. */
export const QUESTIONS: Readonly<Record<Language, readonly TriviaQuestion[]>> = {
    en: BANK.map((one) => one.en),
    es: BANK.map((one) => one.es)
};

/** How many questions a server remembers having asked, so the next games ask
 *  others first. */
export const RECENT_KEPT = 160;

/**
 * The order one game asks the bank in: shuffled for the game, and those the
 * server has not asked lately first - so nothing repeats inside a game, and
 * nothing asked in the last few games comes back while there are others.
 * The same for the same game, so a restart mid-game asks the same next.
 */
export function ordered(runId: string, recent: readonly string[]): BankQuestion[] {
    const all = shuffled(BANK, seeded(`${runId}-bank`));
    const seen = new Set(recent);
    return [...all.filter((one) => !seen.has(one.id)), ...all.filter((one) => seen.has(one.id))];
}

/** What a server remembers after a game that asked `asked`: the newest last,
 *  the oldest let go past `RECENT_KEPT`. */
export function remembered(recent: readonly string[], asked: readonly string[]): string[] {
    const fresh = new Set(asked);
    return [...recent.filter((one) => !fresh.has(one)), ...asked].slice(-RECENT_KEPT);
}

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

/** Whether something said in the chat answers the question: written as the
 *  game's id (`minecraft:ender_pearl`) or in the plural counts too. */
export function answers(said: string, accepted: readonly string[]): boolean {
    const typed = normalizeAnswer(said).replace(/^minecraft (?=.)/, "");
    if (!typed) return false;
    return accepted.some((answer) => {
        const right = normalizeAnswer(answer);
        if (!right) return false;
        const plural = (word: string) => [word, `${word}s`, `${word}es`];
        return plural(right).includes(typed) || plural(typed).includes(right);
    });
}

// ------------------------------------------------------------------ true or false

/**
 * Every way of answering a true-or-false round, by language: the word and its
 * first letter. A round accepts every language's, since each reader is asked
 * the same thing - and they never clash: `f` is false in both, and `t` and `v`
 * are only ever true.
 */
export const TRUTH_WORDS: Readonly<
    Record<Language, Readonly<Record<"true" | "false", readonly string[]>>>
> = {
    en: { true: ["true", "t"], false: ["false", "f"] },
    es: { true: ["verdadero", "v"], false: ["falso", "f"] }
};

/** What something said in the chat answers to a true-or-false round: true,
 *  false, or null when it is neither - compared whole, never as a plural or a
 *  part, so `fs` or `true story` is no answer. */
export function truthSaid(said: string): boolean | null {
    const typed = normalizeAnswer(said);
    if (!typed) return null;
    const saidAs = (side: "true" | "false") =>
        Object.values(TRUTH_WORDS).some((words) => words[side].includes(typed));
    if (saidAs("true")) return true;
    if (saidAs("false")) return false;
    return null;
}

/**
 * Whether a question is a true-or-false one, and which: every answer it
 * accepts is a way of saying the same one of the two. The bank's are written
 * that way (`true`, `verdadero`), and so is an operator's own question
 * answered `true` or `falso` - each then asked with buttons to click.
 */
export function truthOf(question: TriviaQuestion): boolean | null {
    const said = question.answers.map(truthSaid);
    const first = said[0];
    if (first === undefined || first === null) return null;
    return said.every((one) => one === first) ? first : null;
}

/** The answers a true-or-false round accepts in one language, the word first:
 *  it is what the round says the answer was. */
export function truthAnswers(truth: boolean, language: Language): string[] {
    return [...TRUTH_WORDS[language][truth ? "true" : "false"]];
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

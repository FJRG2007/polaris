/**
 * Finding the thing a model means when it names it loosely.
 *
 * `searchItems` (search-text.ts) is the search a person types into: every word
 * has to be there, and a query that matches nothing answers nothing, because a
 * person reads "nothing matches" and types something else. A connected
 * assistant does not. Asked to "open the door", one called the device list with
 * "door"; the only door in the house was "Puerta principal", a `lock`; the list
 * answered "No devices." and the model told its person there was no door.
 *
 * So the searches an assistant runs over MCP go through this instead:
 *
 * - The query is words, folded the way `normalizeSearchText` folds them, with
 *   the words that carry no name ("the", "de la", "please") and the command
 *   words ("open", "abre", "turn on") dropped while anything else is left.
 * - A word matches a word of a row as typed, by a synonym in another language
 *   or by what the row is (`ENTITY_SYNONYMS`: "puerta" and "door" both name a
 *   `lock`), by the start of the word ("purif"), or within a typo or two of it.
 *   Each counts for less than the one before.
 * - A row does not need every word. Rows are ranked by how much of the query
 *   they account for, weighted by the field that carried each word, so "luz del
 *   salon" puts the living room's lamp above the kitchen's.
 * - Quoting a query, or pasting a value (an address, a path), matches it as one
 *   piece, as `isLiteralQuery` decides for the people's search.
 * - Nothing matching is still an answer: `findEntities` hands back the whole
 *   list, bounded, and `fallbackNote` says in a sentence that it is that, so the
 *   model picks from it rather than giving up.
 *
 * Pure and dependency-free: the dashboard's tools and every installable app's
 * run the same matcher, and adding a word is a line in the table below.
 */

import {
    editDistance,
    isLiteralQuery,
    literalNeedle,
    normalizeSearchText,
    type SearchField
} from "./search-text.js";

/**
 * Concepts and the words, already folded, that name them - English and
 * Spanish first, with the commonest words in a few other languages. A word
 * may name more than one concept ("puerta" is a lock and a garage door).
 *
 * The device concepts are Places' device kinds (`lock`, `opener`, ...) plus
 * `camera`, so a row whose kind is the concept's own name matches every word
 * here. One word per entry, lowercase, no accents: a test holds that.
 */
export const ENTITY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
    // Places' device kinds.
    lock: [
        "lock",
        "door",
        "puerta",
        "cerradura",
        "cerrojo",
        "candado",
        "pestillo",
        "latch",
        "deadbolt",
        "smartlock",
        "porte",
        "serrure",
        "tur",
        "schloss",
        "porta",
        "fechadura"
    ],
    opener: [
        "opener",
        "gate",
        "garage",
        "door",
        "puerta",
        "porton",
        "cancela",
        "verja",
        "garaje",
        "cochera",
        "portal",
        "barrier",
        "barrera",
        "intercom",
        "portero",
        "telefonillo"
    ],
    climate: [
        "climate",
        "ac",
        "aircon",
        "air",
        "conditioner",
        "conditioning",
        "hvac",
        "thermostat",
        "heating",
        "heater",
        "cooling",
        "aire",
        "acondicionado",
        "climatizacion",
        "climatizador",
        "clima",
        "termostato",
        "calefaccion",
        "calefactor",
        "split",
        "temperature",
        "temperatura"
    ],
    air: [
        "air",
        "aire",
        "purifier",
        "purificador",
        "humidifier",
        "humidificador",
        "dehumidifier",
        "deshumidificador",
        "fan",
        "ventilador"
    ],
    switch: ["switch", "interruptor", "conmutador", "relay", "rele", "toggle"],
    outlet: ["outlet", "plug", "socket", "enchufe", "toma", "regleta", "power"],
    light: [
        "light",
        "lighting",
        "lamp",
        "bulb",
        "luz",
        "luces",
        "lampara",
        "bombilla",
        "foco",
        "iluminacion",
        "led",
        "aplique",
        "plafon",
        "lumiere",
        "licht"
    ],
    sensor: [
        "sensor",
        "sensores",
        "detector",
        "detectores",
        "motion",
        "movimiento",
        "presence",
        "presencia",
        "contact",
        "contacto",
        "smoke",
        "humo",
        "leak",
        "fuga",
        "flood",
        "inundacion",
        "humidity",
        "humedad",
        "temperature",
        "temperatura",
        "thermometer",
        "termometro"
    ],
    appliance: [
        "appliance",
        "electrodomestico",
        "washer",
        "washing",
        "lavadora",
        "dryer",
        "secadora",
        "dishwasher",
        "lavavajillas",
        "oven",
        "horno",
        "fridge",
        "refrigerator",
        "nevera",
        "frigorifico",
        "vacuum",
        "aspiradora",
        "microwave",
        "microondas",
        "boiler",
        "caldera",
        "termo",
        "cafetera"
    ],
    camera: [
        "camera",
        "cam",
        "cctv",
        "webcam",
        "doorbell",
        "timbre",
        "camara",
        "videocamara",
        "vigilancia",
        "surveillance"
    ],

    // Where things are.
    living: ["living", "lounge", "salon", "sala", "estar"],
    kitchen: ["kitchen", "cocina"],
    bedroom: ["bedroom", "dormitorio", "habitacion", "cuarto", "alcoba", "recamara"],
    bathroom: ["bathroom", "bath", "toilet", "wc", "bano", "aseo", "lavabo"],
    dining: ["dining", "comedor"],
    study: ["study", "office", "oficina", "despacho", "estudio"],
    garden: [
        "garden",
        "yard",
        "backyard",
        "patio",
        "terrace",
        "terraza",
        "jardin",
        "balcony",
        "balcon",
        "porch",
        "porche"
    ],
    entrance: [
        "entrance",
        "entry",
        "front",
        "main",
        "hall",
        "hallway",
        "entrada",
        "recibidor",
        "pasillo",
        "vestibulo",
        "principal"
    ],
    basement: ["basement", "cellar", "sotano", "bodega"],
    home: ["home", "house", "casa", "hogar", "vivienda", "piso", "apartment", "flat"],
    place: ["place", "lugar", "ubicacion", "location", "zone", "zona", "room", "estancia", "area"],

    // What the apps keep.
    server: ["server", "servidor", "srv", "host"],
    game: ["game", "juego", "gaming", "partida"],
    minecraft: ["minecraft", "mc"],
    event: [
        "event",
        "evento",
        "meeting",
        "reunion",
        "cita",
        "appointment",
        "calendar",
        "calendario",
        "agenda",
        "birthday",
        "cumpleanos"
    ],
    routine: [
        "routine",
        "rutina",
        "automation",
        "automatizacion",
        "scene",
        "escena",
        "scenario",
        "escenario"
    ],
    task: ["task", "tarea", "todo", "issue", "ticket", "pendiente"],
    note: ["note", "nota", "apunte", "notebook", "cuaderno", "libreta"],
    file: [
        "file",
        "archivo",
        "fichero",
        "document",
        "documento",
        "doc",
        "folder",
        "carpeta",
        "drive",
        "storage",
        "almacenamiento",
        "photo",
        "foto"
    ],
    mail: ["mail", "email", "correo", "inbox", "bandeja", "message", "mensaje"],
    chat: ["chat", "conversation", "conversacion", "channel", "canal", "group", "grupo", "dm"],
    deploy: [
        "deploy",
        "deployment",
        "despliegue",
        "app",
        "aplicacion",
        "service",
        "servicio",
        "project",
        "proyecto",
        "website",
        "web",
        "site",
        "sitio"
    ],
    database: [
        "database",
        "db",
        "bbdd",
        "base",
        "datos",
        "postgres",
        "postgresql",
        "mysql",
        "mariadb",
        "mongo",
        "mongodb",
        "redis",
        "sql"
    ],
    // What a tool does, for `polaris_tools`' intent: "enviar correo" is the
    // tool that sends, not every tool about mail.
    send: ["send", "enviar", "envia", "mandar", "manda", "reply", "responder"],
    create: ["create", "crear", "crea", "new", "nuevo", "nueva", "add", "anadir", "agregar"],
    delete: ["delete", "borrar", "borra", "eliminar", "elimina", "remove", "quitar"],
    start: ["start", "iniciar", "inicia", "arrancar", "arranca", "encender", "launch", "lanzar"],
    stop: ["stop", "parar", "detener", "apagar", "cancel", "cancelar"]
};

/** Words that never name anything: articles, prepositions, pronouns, please. */
const FILLER = new Set([
    "the",
    "a",
    "an",
    "of",
    "in",
    "on",
    "at",
    "to",
    "for",
    "my",
    "our",
    "your",
    "me",
    "please",
    "and",
    "or",
    "with",
    "from",
    "is",
    "are",
    "this",
    "that",
    "it",
    "el",
    "la",
    "los",
    "las",
    "lo",
    "un",
    "una",
    "unos",
    "unas",
    "de",
    "del",
    "al",
    "en",
    "mi",
    "mis",
    "tu",
    "tus",
    "su",
    "sus",
    "nuestro",
    "nuestra",
    "por",
    "favor",
    "porfa",
    "con",
    "y",
    "o",
    "que",
    "le",
    "les",
    "se",
    "es",
    "esta",
    "este",
    "esa",
    "ese"
]);

/** What somebody asks to have done to a thing, which is not its name. Dropped
 *  only while a word that might be one is left. */
const COMMANDS = new Set([
    "open",
    "close",
    "unlock",
    "start",
    "stop",
    "restart",
    "run",
    "show",
    "find",
    "search",
    "list",
    "get",
    "turn",
    "set",
    "put",
    "check",
    "see",
    "look",
    "enable",
    "disable",
    "activate",
    "deactivate",
    "off",
    "tell",
    "give",
    "where",
    "what",
    "which",
    "abre",
    "abrir",
    "abra",
    "abreme",
    "cierra",
    "cerrar",
    "cierre",
    "enciende",
    "encender",
    "prende",
    "prender",
    "apaga",
    "apagar",
    "desbloquea",
    "desbloquear",
    "bloquea",
    "bloquear",
    "pon",
    "poner",
    "muestra",
    "mostrar",
    "muestrame",
    "busca",
    "buscar",
    "buscame",
    "encuentra",
    "lista",
    "listar",
    "ver",
    "mira",
    "dime",
    "dame",
    "arranca",
    "arrancar",
    "inicia",
    "iniciar",
    "reinicia",
    "reiniciar",
    "para",
    "parar",
    "deten",
    "detener",
    "ejecuta",
    "ejecutar",
    "lanza",
    "activa",
    "activar",
    "desactiva",
    "desactivar",
    "sube",
    "subir",
    "baja",
    "bajar",
    "quiero",
    "puedes",
    "hay",
    "donde",
    "cual"
]);

/** Which concepts each word names, built once from the table. */
const CONCEPTS_OF = (() => {
    const map = new Map<string, Set<string>>();
    for (const [concept, words] of Object.entries(ENTITY_SYNONYMS)) {
        for (const word of [concept, ...words]) {
            const held = map.get(word) ?? new Set<string>();
            held.add(concept);
            map.set(word, held);
        }
    }
    return map;
})();

const VOCABULARY = [...CONCEPTS_OF.keys()];

/** How much each way of matching a word counts, best first. */
const SCORE = {
    exact: 1,
    synonym: 0.85,
    prefix: 0.75,
    fuzzySynonym: 0.7,
    typo: 0.6,
    inside: 0.55,
    /** Added to a row whose title is exactly the query. */
    wholeTitle: 1,
    /** Added to a row whose title contains the query as one piece. */
    inTitle: 0.25
} as const;

/** The least a row has to score, per word of the query, to count as a match
 *  rather than as something close. */
const MATCH_SCORE = 0.3;

/** The words of a text, folded. */
function wordsOf(text: string): string[] {
    return normalizeSearchText(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/** A word and the forms it takes without a plural ending. */
function variants(word: string): string[] {
    const out = [word];
    if (word.length > 3 && word.endsWith("s")) out.push(word.slice(0, -1));
    if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
    return out;
}

function conceptsOf(word: string): Set<string> {
    const found = new Set<string>();
    for (const form of variants(word)) {
        for (const concept of CONCEPTS_OF.get(form) ?? []) found.add(concept);
    }
    return found;
}

/** How many mistakes a word of this length may carry and still be the word. */
function allowedEdits(word: string): number {
    if (word.length < 4) return 0;
    return word.length >= 8 ? 2 : 1;
}

/**
 * The words of a query that can name something: folded, filler dropped, and
 * command words dropped while anything else is left. Exported so a provider
 * that filters in a database can send the same words there.
 */
export function queryTerms(query: string): string[] {
    const all = [...new Set(wordsOf(query))];
    const named = all.filter((word) => !FILLER.has(word));
    const kept = named.length > 0 ? named : all;
    const meant = kept.filter((word) => !COMMANDS.has(word));
    return meant.length > 0 ? meant : kept;
}

/** One word of a query, with what it names. */
interface Term {
    readonly word: string;
    readonly forms: readonly string[];
    readonly concepts: ReadonlySet<string>;
    /** Whether the concepts came from a misspelt synonym rather than the word. */
    readonly guessed: boolean;
}

function termOf(word: string): Term {
    const concepts = conceptsOf(word);
    if (concepts.size > 0 || word.length < 5) {
        return { word, forms: variants(word), concepts, guessed: false };
    }
    // A misspelt synonym ("cerradrua") still names its concept.
    const limit = allowedEdits(word);
    const guessed = new Set<string>();
    for (const known of VOCABULARY) {
        if (Math.abs(known.length - word.length) > limit || known.length < 4) continue;
        if (editDistance(word, known, limit) <= limit) {
            for (const concept of CONCEPTS_OF.get(known) ?? []) guessed.add(concept);
        }
    }
    return { word, forms: variants(word), concepts: guessed, guessed: guessed.size > 0 };
}

/** A word of a row, with what it names. */
interface RowWord {
    readonly word: string;
    readonly forms: readonly string[];
    readonly concepts: ReadonlySet<string>;
}

function rowWord(word: string): RowWord {
    return { word, forms: variants(word), concepts: conceptsOf(word) };
}

/** How well one word of the query matches one word of a row, 0 for not at all. */
function wordScore(term: Term, word: RowWord): number {
    if (term.forms.some((form) => word.forms.includes(form))) return SCORE.exact;
    let best = 0;
    for (const concept of term.concepts) {
        if (word.concepts.has(concept)) {
            best = term.guessed ? SCORE.fuzzySynonym : SCORE.synonym;
            break;
        }
    }
    if (best >= SCORE.prefix) return best;
    if (term.word.length >= 3 && word.word.startsWith(term.word)) return SCORE.prefix;
    const limit = allowedEdits(term.word);
    if (limit > 0 && word.word.length >= 4) {
        const off = editDistance(term.word, word.word, limit);
        if (off <= limit) best = Math.max(best, SCORE.typo - (off - 1) * 0.1);
    }
    if (term.word.length >= 4 && word.word.includes(term.word)) {
        best = Math.max(best, SCORE.inside);
    }
    return best;
}

/** A row's fields as words, and its title as one folded string. */
interface ReadRow {
    readonly fields: readonly (readonly RowWord[])[];
    readonly texts: readonly string[];
    readonly title: readonly string[];
}

function textsOf(value: ReturnType<SearchField<unknown>["text"]>): string[] {
    const values = typeof value === "string" ? [value] : (value ?? []);
    return values.filter((one): one is string => Boolean(one));
}

function readRow<T>(item: T, fields: readonly SearchField<T>[]): ReadRow {
    const texts: string[] = [];
    const words = fields.map((field) => {
        const values = textsOf(field.text(item));
        texts.push(...values.map(normalizeSearchText));
        return values.flatMap(wordsOf).map(rowWord);
    });
    const title = textsOf(fields[0]?.text(item)).map((value) => wordsOf(value).join(" "));
    return { fields: words, texts, title };
}

/** A row and how well it matched; higher is better. */
export interface RankedEntity<T> {
    readonly item: T;
    readonly score: number;
}

/**
 * Every row that shares anything with the query, best first; rows that matched
 * equally keep the order they were given in. An empty query ranks nothing.
 *
 * `fields` are read as `searchItems` reads them: the first is the title, and a
 * field's weight (1 when left out) scales what a word found there counts for.
 */
export function rankEntities<T>(
    items: readonly T[],
    query: string,
    fields: readonly SearchField<T>[]
): RankedEntity<T>[] {
    if (isLiteralQuery(query)) {
        const needle = normalizeSearchText(literalNeedle(query));
        if (!needle) return [];
        return items
            .filter((item) => readRow(item, fields).texts.some((text) => text.includes(needle)))
            .map((item) => ({ item, score: SCORE.exact }));
    }
    const words = queryTerms(query);
    if (words.length === 0) return [];
    const terms = words.map(termOf);
    const phrase = words.join(" ");

    const ranked: { item: T; score: number; at: number }[] = [];
    items.forEach((item, at) => {
        const row = readRow(item, fields);
        let total = 0;
        for (const term of terms) {
            let best = 0;
            row.fields.forEach((rowWords, index) => {
                const weight = fields[index]?.weight ?? 1;
                for (const word of rowWords) {
                    const score = wordScore(term, word) * weight;
                    if (score > best) best = score;
                }
            });
            total += best;
        }
        if (total === 0) return;
        let score = total / terms.length;
        if (row.title.includes(phrase)) score += SCORE.wholeTitle;
        else if (row.title.some((title) => title.includes(phrase))) score += SCORE.inTitle;
        ranked.push({ item, score, at });
    });
    ranked.sort((left, right) => right.score - left.score || left.at - right.at);
    return ranked.map(({ item, score }) => ({ item, score }));
}

/**
 * What a tolerant search answered with:
 *
 * - `all`: there was no query, so every row.
 * - `matched`: the rows that matched, best first.
 * - `closest`: none matched well, so the ones that came nearest.
 * - `none`: nothing shared a word with the query, so every row anyway.
 */
export type EntityOutcome = "all" | "matched" | "closest" | "none";

export interface FoundEntities<T> {
    readonly items: T[];
    readonly outcome: EntityOutcome;
    /** How many rows that answer had before it was bounded. */
    readonly total: number;
}

/**
 * The rows a model should be shown for a query, never none while there are
 * any: the matches, else the closest, else the whole list - each bounded by
 * `limit` when one is given.
 */
export function findEntities<T>(
    items: readonly T[],
    query: string,
    fields: readonly SearchField<T>[],
    options: { readonly limit?: number } = {}
): FoundEntities<T> {
    const bound = (rows: readonly T[]) =>
        options.limit === undefined ? [...rows] : rows.slice(0, options.limit);
    if (!query.trim()) return { items: bound(items), outcome: "all", total: items.length };
    const ranked = rankEntities(items, query, fields);
    const matched = ranked.filter((entry) => entry.score >= MATCH_SCORE);
    if (matched.length > 0) {
        return {
            items: bound(matched.map((entry) => entry.item)),
            outcome: "matched",
            total: matched.length
        };
    }
    if (ranked.length > 0) {
        return {
            items: bound(ranked.map((entry) => entry.item)),
            outcome: "closest",
            total: ranked.length
        };
    }
    return { items: bound(items), outcome: "none", total: items.length };
}

/**
 * The sentence that tells a model an answer is not a match, so it reads the
 * list as candidates rather than as what it asked for; null when it is a
 * match. English, as every tool's text is: it is read by the model.
 */
export function fallbackNote(
    query: string,
    found: { readonly outcome: EntityOutcome; readonly shown: number; readonly total: number },
    noun: { readonly one: string; readonly other: string }
): string | null {
    if (found.outcome === "all" || found.outcome === "matched") return null;
    const what = found.total === 1 ? noun.one : noun.other;
    const asked = query.trim();
    if (found.outcome === "closest") {
        return found.shown < found.total
            ? `No exact match for "${asked}"; these are the closest ${found.shown} of ${found.total} ${what}.`
            : `No exact match for "${asked}"; these are the closest ${what}.`;
    }
    return found.shown < found.total
        ? `No match for "${asked}"; these are the first ${found.shown} of ${found.total} ${what}.`
        : `No match for "${asked}"; these are all ${found.total} ${what}.`;
}

/** What a tool hands a model for a query: the rows, the sentence that goes
 *  above them when they are not a match, and whether they are one. */
export interface ModelMatch<T> {
    readonly items: T[];
    readonly note: string | null;
    /** True for a match, and for no query at all. */
    readonly matched: boolean;
}

/**
 * `findEntities` and `fallbackNote` together, the way every MCP list tool
 * uses them. Paged tools leave `limit` out and page what comes back; the note
 * then counts every row rather than the page.
 */
export function matchForModel<T>(
    items: readonly T[],
    query: string,
    fields: readonly SearchField<T>[],
    noun: { readonly one: string; readonly other: string },
    limit?: number
): ModelMatch<T> {
    const found = findEntities(items, query, fields, limit === undefined ? {} : { limit });
    return {
        items: found.items,
        note: fallbackNote(
            query,
            { outcome: found.outcome, shown: found.items.length, total: found.total },
            noun
        ),
        matched: found.outcome === "matched" || found.outcome === "all"
    };
}

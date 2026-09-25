/**
 * Words Polaris fills in when it sends text to the game: `{player}`,
 * `{server.online}`, `{polaris.name | "Player"}`.
 *
 * Three kinds, told apart because each is filled in somewhere else:
 *
 * - **The game's**, per player: the name, level and health of whoever reads the
 *   line. Minecraft does these itself - a `selector` or `score` text component
 *   resolved for `@s` when the command runs as that player - so they need no
 *   list of who is online and are never stale.
 * - **The account's**, per player: the Polaris account a player is tied to.
 *   Only Polaris knows that, so a line using one is written once per player
 *   online, with their own values in it.
 * - **The server's**, the same for everybody: how many are online, the server's
 *   name, who is in the call of the chat group chosen for this server.
 *
 * `| "text"` after a name is what to write when there is no value - a player
 * with no Polaris account, a server with no chat group chosen. Without one, an
 * empty value is written as nothing.
 *
 * Pure: parsing, checking and filling in can all be asserted without a server,
 * and the editor checks as it is typed with the same functions the send uses.
 */

import type { MinecraftEdition } from "./service";

/** Where a variable's value comes from. */
export type VariableKind = "game" | "account" | "server";

export interface VariableSpec {
    readonly name: string;
    readonly label: string;
    readonly kind: VariableKind;
    /** What the preview shows for it. */
    readonly sample: string;
    /** For a game variable: the text component that draws it for `@s`. */
    readonly component?: Readonly<Record<string, unknown>>;
    /** For a score: the objective and the criterion that keeps it current. */
    readonly objective?: { readonly name: string; readonly criterion: string };
    /** Whether Bedrock can draw it: its scoreboard has no criteria but `dummy`. */
    readonly bedrock: boolean;
    /**
     * How long a value is taken to be, for the counter under a field. A list of
     * names has no longest, so it counts as a few of them: the counter is a guide
     * to what fits, and the game cuts a line that runs past the screen.
     */
    readonly width: number;
}

const LEVEL = { name: "polaris_level", criterion: "level" } as const;
const HEALTH = { name: "polaris_health", criterion: "health" } as const;

export const VARIABLES: readonly VariableSpec[] = [
    {
        name: "player",
        label: "Player name",
        kind: "game",
        sample: "Steve",
        component: { selector: "@s" },
        bedrock: true,
        width: 16
    },
    {
        name: "player.level",
        label: "Player level",
        kind: "game",
        sample: "12",
        component: { score: { name: "@s", objective: LEVEL.name } },
        objective: LEVEL,
        bedrock: false,
        width: 4
    },
    {
        name: "player.health",
        label: "Player health",
        kind: "game",
        sample: "20",
        component: { score: { name: "@s", objective: HEALTH.name } },
        objective: HEALTH,
        bedrock: false,
        width: 2
    },
    {
        name: "polaris.name",
        label: "Polaris account name",
        kind: "account",
        sample: "Ada Lovelace",
        bedrock: true,
        width: 32
    },
    {
        name: "polaris.username",
        label: "Polaris username",
        kind: "account",
        sample: "ada",
        bedrock: true,
        width: 32
    },
    {
        name: "server.name",
        label: "Server name",
        kind: "server",
        sample: "Survival",
        bedrock: true,
        width: 32
    },
    {
        name: "server.online",
        label: "Players online",
        kind: "server",
        sample: "3",
        bedrock: true,
        width: 3
    },
    {
        name: "server.max",
        label: "Player slots",
        kind: "server",
        sample: "20",
        bedrock: true,
        width: 3
    },
    {
        name: "server.players",
        label: "Who is online",
        kind: "server",
        sample: "Steve, Alex",
        bedrock: true,
        width: 24
    },
    {
        name: "call.count",
        label: "People in the group's call",
        kind: "server",
        sample: "2",
        bedrock: true,
        width: 3
    },
    {
        name: "call.members",
        label: "Who is in the group's call",
        kind: "server",
        sample: "Ada, Grace",
        bedrock: true,
        width: 24
    }
];

const BY_NAME = new Map(VARIABLES.map((spec) => [spec.name, spec]));

/** `{player.name}` is what somebody will type for `{player}`; both work. */
const ALIASES: Readonly<Record<string, string>> = { "player.name": "player" };

export function variable(name: string): VariableSpec | null {
    const key = name.toLowerCase();
    return BY_NAME.get(ALIASES[key] ?? key) ?? null;
}

/** The longest fallback text, so a fallback is a word and not a paragraph. */
export const FALLBACK_MAX = 40;

/** One `{...}` in a text, as written. */
export interface VariableUse {
    readonly raw: string;
    readonly name: string;
    readonly fallback: string | null;
    readonly spec: VariableSpec | null;
}

/** `{ name }` or `{ name | "fallback" }`. The fallback is quoted so it can hold
 *  spaces and punctuation, and cannot hold a quote or a brace. */
const TOKEN = /\{\s*([A-Za-z][\w.]*)\s*(?:\|\s*"([^"{}]*)"\s*)?\}/g;

/** Every variable a text uses, known or not. */
export function variablesIn(text: string): VariableUse[] {
    const found: VariableUse[] = [];
    for (const match of text.matchAll(TOKEN)) {
        const name = match[1] as string;
        found.push({ raw: match[0], name, fallback: match[2] ?? null, spec: variable(name) });
    }
    return found;
}

/**
 * What is wrong with the variables in one field, in words for under it, or null.
 *
 * A brace that does not make a variable is refused rather than sent as written:
 * a typo in a name would otherwise reach every screen as `{palyer}`.
 */
export function variableProblem(text: string, edition: MinecraftEdition): string | null {
    for (const use of variablesIn(text)) {
        if (!use.spec) return `{${use.name}} is not something Polaris can fill in`;
        if (use.fallback !== null && use.fallback.length > FALLBACK_MAX) {
            return `The text after | is at most ${FALLBACK_MAX} characters`;
        }
        if (edition === "bedrock" && !use.spec.bedrock) {
            return `Bedrock cannot show {${use.spec.name}}`;
        }
    }
    const rest = text.replace(TOKEN, "");
    if (/[{}]/.test(rest)) {
        return 'A { } has to hold a variable, like {player} or {polaris.name | "Player"}';
    }
    return null;
}

/** Whether a text needs anything worked out per player. */
export function usesPerPlayer(text: string): boolean {
    return variablesIn(text).some((use) => use.spec && use.spec.kind !== "server");
}

/** Whether filling it in needs the server asked who is online: a count, the
 *  list, or the account of each player on. */
export function readsPlayerList(text: string): boolean {
    return variablesIn(text).some(
        (use) =>
            use.spec?.kind === "account" ||
            ["server.online", "server.max", "server.players"].includes(use.spec?.name ?? "")
    );
}

/** Whether it needs the account a player is tied to. */
export function usesAccount(text: string): boolean {
    return variablesIn(text).some((use) => use.spec?.kind === "account");
}

/** The scores a text reads, so the objectives behind them exist before it goes. */
export function objectivesIn(text: string): { name: string; criterion: string }[] {
    const found = new Map<string, { name: string; criterion: string }>();
    for (const use of variablesIn(text)) {
        const objective = use.spec?.objective;
        if (objective) found.set(objective.name, objective);
    }
    return [...found.values()];
}

/** Values Polaris knows: the server's for everybody, the account's for one
 *  player. Null is "not known", which the fallback stands in for. */
export type VariableValues = Readonly<Record<string, string | null>>;

/** Nothing a value brings in may format the line or open a variable of its own. */
function plainValue(value: string): string {
    return value.replace(/[&§]/g, "").replace(/[{}\r\n\0]/g, "");
}

/**
 * The text with every value Polaris knows written in, and the game's own
 * variables left for the component that draws them.
 *
 * A game variable is left as `{name}` whatever fallback it was written with: the
 * game always has a name, a level and a health to show.
 */
export function fillValues(text: string, values: VariableValues): string {
    return text.replace(TOKEN, (raw, name: string, fallback: string | undefined) => {
        const spec = variable(name);
        if (!spec) return raw;
        if (spec.kind === "game") return `{${spec.name}}`;
        const value = values[spec.name];
        return plainValue(value ?? fallback ?? "");
    });
}

/** The text as the preview draws it, every variable at its sample or fallback. */
export function previewText(text: string, values: VariableValues = {}): string {
    return text.replace(TOKEN, (raw, name: string, fallback: string | undefined) => {
        const spec = variable(name);
        if (!spec) return raw;
        const value = values[spec.name];
        if (value !== undefined) return plainValue(value ?? fallback ?? "");
        return plainValue(spec.sample);
    });
}

/**
 * How long a text will be on screen at most, for the counter under a field: its
 * visible characters, with each variable counted at the widest value it takes.
 */
export function visibleLength(plain: string): number {
    let length = 0;
    let last = 0;
    for (const match of plain.matchAll(TOKEN)) {
        length += (match.index ?? 0) - last;
        const spec = variable(match[1] as string);
        const fallback = match[2]?.length ?? 0;
        length += spec ? Math.max(spec.width, fallback) : match[0].length;
        last = (match.index ?? 0) + match[0].length;
    }
    return length + plain.length - last;
}

/** Splits text into plain runs and the game variables left in it by `fillValues`. */
const GAME_SPLIT = /(\{(?:player|player\.level|player\.health)\})/i;

/** A run of text, or a game variable to draw in its place. */
export type Piece = { readonly text: string } | { readonly component: Record<string, unknown> };

export function gamePieces(text: string): Piece[] {
    const pieces: Piece[] = [];
    for (const part of text.split(GAME_SPLIT)) {
        if (!part) continue;
        const spec = GAME_SPLIT.test(part) ? variable(part.slice(1, -1)) : null;
        pieces.push(spec?.component ? { component: { ...spec.component } } : { text: part });
    }
    return pieces;
}

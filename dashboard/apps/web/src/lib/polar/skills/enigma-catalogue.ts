/**
 * The skills and "/" commands Enigma ships, read from its published package.
 *
 * A version's package never changes once published, so its skills are read once
 * per version: fetched from where it is published, read entry by entry without unpacking
 * anything, and stored under that version. Every later read is the stored copy -
 * from memory, else from the setting store - and a newer pinned version simply
 * reads its own key and forgets the old one. Nothing here runs a CLI or npm.
 *
 * A registry that cannot be reached is an empty catalogue for a while, never an
 * error: the screen says the list is unavailable and a chat lists none.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { Readable } from "node:stream";
import { readTarEntries } from "@polaris/deploy";
import { getSetting, setSetting } from "@/lib/setting-store";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";

export interface EnigmaSkill {
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
}

/** One of the "/" commands Enigma ships (`assets/commands/<name>.md`). */
export interface EnigmaCommand {
    readonly name: string;
    readonly description: string;
    /** What the command takes after its name, as its front matter spells it. */
    readonly argumentHint: string | null;
    readonly instructions: string;
    /** False when its instructions run a shell or work on a repository, so it
     *  can only run inside a Code session, never in a chat. */
    readonly chat: boolean;
}

export interface EnigmaCatalogue {
    readonly version: string;
    /** False while the package could not be read: the list is unknown, not empty. */
    readonly available: boolean;
    readonly skills: readonly EnigmaSkill[];
    readonly commands: readonly EnigmaCommand[];
}

/** A published package is around a megabyte; this is the most fetched. */
export const ENIGMA_TARBALL_MAX = 20 * 1024 * 1024;
/** The largest skill file kept. The longest one shipped is about 110 KB. */
const ENTRY_MAX = 512 * 1024;
const DESCRIPTION_MAX = 1024;
/** More skills than the package has ever shipped. */
const SKILLS_MOST = 100;
/** More commands than the package has ever shipped (1.73.0 ships four). */
const COMMANDS_MOST = 50;
const HINT_MAX = 200;
/** How long a failed read is remembered before the registry is asked again. */
const RETRY_MS = 10 * 60 * 1000;
const KEY_PREFIX = "enigma.skills.";
const COMMANDS_PREFIX = "enigma.commands.";
const VERSION = /^\d+\.\d+\.\d+$/;
const SKILL_PATH = /^package\/assets\/skills\/([a-z0-9][a-z0-9-]{0,63})\/(skill\.json|SKILL\.md)$/;
const COMMAND_PATH = /^package\/assets\/commands\/([a-z0-9][a-z0-9-]{0,63})\.md$/;

const manifestSchema = z.object({
    name: z.string().regex(core.ENIGMA_SKILL_NAME),
    description: z.string().trim().min(1)
});

const storedSchema = z
    .array(
        z.object({
            name: z.string().regex(core.ENIGMA_SKILL_NAME),
            description: z.string().max(DESCRIPTION_MAX),
            instructions: z.string()
        })
    )
    .max(SKILLS_MOST);

const storedCommandsSchema = z
    .array(
        z.object({
            name: z.string().regex(core.ENIGMA_SKILL_NAME),
            description: z.string().max(DESCRIPTION_MAX),
            argumentHint: z.string().max(HINT_MAX).nullable(),
            instructions: z.string(),
            chat: z.boolean()
        })
    )
    .max(COMMANDS_MOST);

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** One field of a front matter block, unquoted, or null when it is absent or empty. */
function frontField(front: string | undefined, field: string): string | null {
    const line = front?.split(/\r?\n/).find((entry) => entry.startsWith(`${field}:`));
    return line?.slice(field.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2") || null;
}

/** A SKILL.md's body, and the description its front matter gives - the one
 *  written to say when the skill applies, longer than the manifest's. */
function readSkillMarkdown(markdown: string): { body: string; description: string | null } {
    const front = FRONT_MATTER.exec(markdown)?.[1];
    return { body: markdown.replace(FRONT_MATTER, "").trim(), description: frontField(front, "description") };
}

/** A shell block, or a command line quoted inline, in a command's instructions. */
const SHELL = /```(?:bash|sh|shell|console|zsh)\b|`(?:enigma|git|gh|npm|npx|pnpm|yarn|bun)\s/;
/** Words that only mean something with a checkout to work on. */
const WORKSPACE =
    /\b(?:repositor(?:y|ies)|repo|branch(?:es)?|codebase|commits?|worktree|working tree|pull requests?|this project)\b/i;

/**
 * Whether a command's instructions can be followed in a chat, which has no
 * shell and no checkout. The package says nothing about it, so it is read from
 * the instructions themselves: one that runs a command line or works on a
 * repository needs a Code session.
 */
export function runsInChat(instructions: string): boolean {
    return !SHELL.test(instructions) && !WORKSPACE.test(instructions);
}

/** The commands in a package's files, by `assets/commands/<name>.md`, sorted by name. */
export function parseEnigmaCommands(files: ReadonlyMap<string, Buffer>): EnigmaCommand[] {
    const commands: EnigmaCommand[] = [];
    for (const [path, data] of files) {
        const name = COMMAND_PATH.exec(path)?.[1];
        if (!name) continue;
        const markdown = data.toString("utf8");
        const front = FRONT_MATTER.exec(markdown)?.[1];
        const description = frontField(front, "description");
        const body = markdown.replace(FRONT_MATTER, "").trim();
        if (!description || !body) continue;
        commands.push({
            name,
            description: description.slice(0, DESCRIPTION_MAX),
            argumentHint: frontField(front, "argument-hint")?.slice(0, HINT_MAX) ?? null,
            instructions: body,
            chat: runsInChat(body)
        });
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name)).slice(0, COMMANDS_MOST);
}

/** The skills in a package's files, by `assets/skills/<name>/`, sorted by name. */
export function parseEnigmaSkills(files: ReadonlyMap<string, Buffer>): EnigmaSkill[] {
    const dirs = new Map<string, { manifest?: Buffer; body?: Buffer }>();
    for (const [path, data] of files) {
        const match = SKILL_PATH.exec(path);
        if (!match) continue;
        const entry = dirs.get(match[1]!) ?? {};
        if (match[2] === "skill.json") entry.manifest = data;
        else entry.body = data;
        dirs.set(match[1]!, entry);
    }
    const skills: EnigmaSkill[] = [];
    for (const [dir, entry] of dirs) {
        if (!entry.manifest || !entry.body) continue;
        let raw: unknown;
        try {
            raw = JSON.parse(entry.manifest.toString("utf8"));
        } catch {
            continue;
        }
        const manifest = manifestSchema.safeParse(raw);
        if (!manifest.success || manifest.data.name !== dir) continue;
        const { body, description } = readSkillMarkdown(entry.body.toString("utf8"));
        if (!body) continue;
        skills.push({
            name: dir,
            description: (description ?? manifest.data.description).slice(0, DESCRIPTION_MAX),
            instructions: body
        });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name)).slice(0, SKILLS_MOST);
}

/** The skills and commands in a package tarball, or null when it is not one. */
export async function readEnigmaPackage(
    bytes: Uint8Array
): Promise<{ skills: EnigmaSkill[]; commands: EnigmaCommand[] } | null> {
    const files = await readTarEntries(
        Readable.from([Buffer.from(bytes)]),
        (name) => SKILL_PATH.test(name) || COMMAND_PATH.test(name),
        ENTRY_MAX
    ).catch(() => null);
    return files ? { skills: parseEnigmaSkills(files), commands: parseEnigmaCommands(files) } : null;
}

/** The skills in a package tarball, or null when it is not one. */
export async function readEnigmaTarball(bytes: Uint8Array): Promise<EnigmaSkill[] | null> {
    return (await readEnigmaPackage(bytes))?.skills ?? null;
}

/**
 * Where one version's tarball is published: the GitHub release first, since
 * releases from 1.73.0 on are published there only, then the npm registry,
 * which holds the versions before that.
 */
const TARBALL_SOURCES = [
    (version: string) => `https://github.com/FJRG2007/enigma/releases/download/v${version}/enigma-cli-${version}.tgz`,
    (version: string) => `https://registry.npmjs.org/enigma-cli/-/enigma-cli-${version}.tgz`
];

/** One version's tarball, through the vetted fetch. */
async function fetchTarball(version: string): Promise<Uint8Array | null> {
    for (const source of TARBALL_SOURCES) {
        const url = safeUrl(source(version));
        if (!url) continue;
        const response = await follow(url, "application/octet-stream").catch(() => null);
        if (response?.ok) return readCapped(response, ENIGMA_TARBALL_MAX);
        await response?.body?.cancel().catch(() => undefined);
    }
    return null;
}

export type TarballFetcher = (version: string) => Promise<Uint8Array | null>;

interface Remembered {
    readonly skills: readonly EnigmaSkill[];
    readonly commands: readonly EnigmaCommand[];
    readonly available: boolean;
    /** False until both lists are read: an unavailable catalogue, or skills
     *  from a stored copy whose commands could not be read yet. Asked again. */
    readonly complete: boolean;
    readonly at: number;
}

/** A stored copy that still parses, or null. */
async function readStored<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const stored = await getSetting(key).catch(() => null);
    if (!stored) return null;
    try {
        const parsed = schema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : null;
    } catch {
        // Unreadable: read the package again and store over it.
        return null;
    }
}

const remembered = new Map<string, Remembered>();
const reading = new Map<string, Promise<Remembered>>();

async function load(version: string, fetcher: TarballFetcher): Promise<Remembered> {
    const key = `${KEY_PREFIX}${version}`;
    const commandsKey = `${COMMANDS_PREFIX}${version}`;
    const [storedSkills, storedCommands] = await Promise.all([
        readStored(key, storedSchema),
        readStored(commandsKey, storedCommandsSchema)
    ]);
    const known = storedSkills && storedSkills.length > 0 ? storedSkills : null;
    // A copy stored before commands were read has no commands key: the package
    // is read once more for them.
    if (known && storedCommands)
        return { skills: known, commands: storedCommands, available: true, complete: true, at: Date.now() };
    const bytes = await fetcher(version).catch(() => null);
    const read = bytes ? await readEnigmaPackage(bytes) : null;
    if (!read || read.skills.length === 0) {
        return known
            ? { skills: known, commands: [], available: true, complete: false, at: Date.now() }
            : { skills: [], commands: [], available: false, complete: false, at: Date.now() };
    }
    await Promise.all([
        setSetting(key, JSON.stringify(read.skills)),
        setSetting(commandsKey, JSON.stringify(read.commands))
    ]).catch((error: unknown) => {
        console.error("enigma: could not store the skills catalogue", error);
    });
    // One version is ever in use; an older one's copy is nothing anybody reads.
    await Promise.all(
        [
            { prefix: KEY_PREFIX, keep: key },
            { prefix: COMMANDS_PREFIX, keep: commandsKey }
        ].map(({ prefix, keep }) =>
            prisma.setting
                .deleteMany({ where: { key: { startsWith: prefix, not: keep } } })
                .catch(() => undefined)
        )
    );
    return { skills: read.skills, commands: read.commands, available: true, complete: true, at: Date.now() };
}

function refresh(version: string, fetcher: TarballFetcher): Promise<Remembered> {
    const running = reading.get(version);
    if (running) return running;
    const next = load(version, fetcher)
        .then((value) => {
            remembered.set(version, value);
            return value;
        })
        .finally(() => reading.delete(version));
    reading.set(version, next);
    return next;
}

/**
 * The skills and commands of one Enigma version, the pinned one by default.
 *
 * Read once per version and process. A failed read answers an empty,
 * unavailable catalogue; once it is old, the next read still answers it at once
 * and asks the registry again behind it.
 */
export async function enigmaCatalogue(
    version: string = core.ENIGMA_VERSION,
    fetcher: TarballFetcher = fetchTarball
): Promise<EnigmaCatalogue> {
    if (!VERSION.test(version)) return { version, available: false, skills: [], commands: [] };
    const known = remembered.get(version);
    if (known && !known.complete && Date.now() - known.at > RETRY_MS) void refresh(version, fetcher);
    const value = known ?? (await refresh(version, fetcher));
    return { version, available: value.available, skills: value.skills, commands: value.commands };
}

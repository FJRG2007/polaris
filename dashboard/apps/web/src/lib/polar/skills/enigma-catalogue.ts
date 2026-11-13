/**
 * The skills Enigma ships, read from its published package.
 *
 * A version's package never changes once published, so its skills are read once
 * per version: fetched from the registry, read entry by entry without unpacking
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

export interface EnigmaCatalogue {
    readonly version: string;
    /** False while the package could not be read: the list is unknown, not empty. */
    readonly available: boolean;
    readonly skills: readonly EnigmaSkill[];
}

/** A published package is around a megabyte; this is the most fetched. */
export const ENIGMA_TARBALL_MAX = 20 * 1024 * 1024;
/** The largest skill file kept. The longest one shipped is about 110 KB. */
const ENTRY_MAX = 512 * 1024;
const DESCRIPTION_MAX = 1024;
/** More skills than the package has ever shipped. */
const SKILLS_MOST = 100;
/** How long a failed read is remembered before the registry is asked again. */
const RETRY_MS = 10 * 60 * 1000;
const KEY_PREFIX = "enigma.skills.";
const VERSION = /^\d+\.\d+\.\d+$/;
const SKILL_PATH = /^package\/assets\/skills\/([a-z0-9][a-z0-9-]{0,63})\/(skill\.json|SKILL\.md)$/;

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

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** A SKILL.md's body, and the description its front matter gives - the one
 *  written to say when the skill applies, longer than the manifest's. */
function readSkillMarkdown(markdown: string): { body: string; description: string | null } {
    const front = FRONT_MATTER.exec(markdown);
    const line = front?.[1]?.split(/\r?\n/).find((entry) => entry.startsWith("description:"));
    const description = line?.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2") || null;
    return { body: markdown.replace(FRONT_MATTER, "").trim(), description };
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

/** The skills in a package tarball, or null when it is not one. */
export async function readEnigmaTarball(bytes: Uint8Array): Promise<EnigmaSkill[] | null> {
    const files = await readTarEntries(
        Readable.from([Buffer.from(bytes)]),
        (name) => SKILL_PATH.test(name),
        ENTRY_MAX
    ).catch(() => null);
    return files ? parseEnigmaSkills(files) : null;
}

/** One version's tarball from the public registry, through the vetted fetch. */
async function fetchTarball(version: string): Promise<Uint8Array | null> {
    const url = safeUrl(`https://registry.npmjs.org/enigma-cli/-/enigma-cli-${version}.tgz`);
    if (!url) return null;
    const response = await follow(url, "application/octet-stream");
    if (!response?.ok) return null;
    return readCapped(response, ENIGMA_TARBALL_MAX);
}

export type TarballFetcher = (version: string) => Promise<Uint8Array | null>;

interface Remembered {
    readonly skills: readonly EnigmaSkill[];
    readonly available: boolean;
    readonly at: number;
}

const remembered = new Map<string, Remembered>();
const reading = new Map<string, Promise<Remembered>>();

async function load(version: string, fetcher: TarballFetcher): Promise<Remembered> {
    const key = `${KEY_PREFIX}${version}`;
    const stored = await getSetting(key).catch(() => null);
    if (stored) {
        try {
            const parsed = storedSchema.safeParse(JSON.parse(stored));
            if (parsed.success && parsed.data.length > 0)
                return { skills: parsed.data, available: true, at: Date.now() };
        } catch {
            // Unreadable: read the package again and store over it.
        }
    }
    const bytes = await fetcher(version).catch(() => null);
    const skills = bytes ? await readEnigmaTarball(bytes) : null;
    if (!skills || skills.length === 0) return { skills: [], available: false, at: Date.now() };
    await setSetting(key, JSON.stringify(skills)).catch((error: unknown) => {
        console.error("enigma: could not store the skills catalogue", error);
    });
    // One version is ever in use; an older one's copy is nothing anybody reads.
    await prisma.setting
        .deleteMany({ where: { key: { startsWith: KEY_PREFIX, not: key } } })
        .catch(() => undefined);
    return { skills, available: true, at: Date.now() };
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
 * The skills of one Enigma version, the pinned one by default.
 *
 * Read once per version and process. A failed read answers an empty,
 * unavailable catalogue; once it is old, the next read still answers it at once
 * and asks the registry again behind it.
 */
export async function enigmaCatalogue(
    version: string = core.ENIGMA_VERSION,
    fetcher: TarballFetcher = fetchTarball
): Promise<EnigmaCatalogue> {
    if (!VERSION.test(version)) return { version, available: false, skills: [] };
    const known = remembered.get(version);
    if (known && !known.available && Date.now() - known.at > RETRY_MS) void refresh(version, fetcher);
    const value = known ?? (await refresh(version, fetcher));
    return { version, available: value.available, skills: value.skills };
}

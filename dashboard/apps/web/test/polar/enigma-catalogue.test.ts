/**
 * Enigma's skills catalogue: read from a package tarball entry by entry, kept
 * once per version, and an empty, unavailable list when the registry cannot be
 * reached - never an error.
 */

import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => void settings.set(key, value)
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            deleteMany: async ({ where }: { where: { key: { startsWith: string; not: string } } }) => {
                for (const key of [...settings.keys()])
                    if (key.startsWith(where.key.startsWith) && key !== where.key.not) settings.delete(key);
            }
        }
    }
}));
vi.mock("@/lib/safe-fetch", () => ({ follow: async () => null, readCapped: async () => null, safeUrl: () => null }));

const { enigmaCatalogue, readEnigmaPackage, readEnigmaTarball, runsInChat } = await import(
    "@/lib/polar/skills/enigma-catalogue"
);

/** One tar entry: a ustar header, the content, and padding to the block. */
function entry(name: string, text: string): Buffer {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512, 0)]);
}

function skill(name: string, description: string, body: string): Buffer[] {
    return [
        entry(`package/assets/skills/${name}/skill.json`, JSON.stringify({ name, description: "Short." })),
        entry(`package/assets/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
    ];
}

/** A package tarball shaped like the published one. */
const TARBALL = gzipSync(
    Buffer.concat([
        entry("package/package.json", "{}"),
        ...skill("git-policy", "Commits and branches.", "Commit small."),
        ...skill("ci-policy", "Pipelines.", "Cache by hash."),
        // A manifest whose name is not its folder's, and a folder with no body.
        entry("package/assets/skills/odd/skill.json", JSON.stringify({ name: "other", description: "x" })),
        entry("package/assets/skills/odd/SKILL.md", "body"),
        entry("package/assets/skills/lonely/skill.json", JSON.stringify({ name: "lonely", description: "x" })),
        // Commands shaped like the 1.73.0 ones: one that runs a shell, one
        // that only talks, one with no description and one nested too deep.
        entry(
            "package/assets/commands/gate.md",
            "---\ndescription: Validate code changes through the gate.\nargument-hint: [task] | on | off\n---\n\n# /gate\n\n```bash\nenigma gate axi run\n```\n"
        ),
        entry(
            "package/assets/commands/recap.md",
            "---\ndescription: \"Sum up the conversation so far.\"\n---\n\nSum up: **$ARGUMENTS**\n"
        ),
        entry("package/assets/commands/blank.md", "---\nargument-hint: x\n---\n\nNo description.\n"),
        entry("package/assets/commands/deep/inner.md", "---\ndescription: d\n---\n\nbody\n"),
        Buffer.alloc(1024, 0)
    ])
);

beforeEach(() => settings.clear());

describe("readEnigmaTarball", () => {
    it("reads each skill's name, its front matter's description and its body", async () => {
        expect(await readEnigmaTarball(TARBALL)).toEqual([
            { name: "ci-policy", description: "Pipelines.", instructions: "Cache by hash." },
            { name: "git-policy", description: "Commits and branches.", instructions: "Commit small." }
        ]);
    });

    it("answers null for bytes that are not a tarball", async () => {
        expect(await readEnigmaTarball(Buffer.from("not a tarball"))).toBeNull();
    });

    it("reads each command's description, argument hint, body and where it can run", async () => {
        expect((await readEnigmaPackage(TARBALL))?.commands).toEqual([
            {
                name: "gate",
                description: "Validate code changes through the gate.",
                argumentHint: "[task] | on | off",
                instructions: "# /gate\n\n```bash\nenigma gate axi run\n```",
                chat: false
            },
            {
                name: "recap",
                description: "Sum up the conversation so far.",
                argumentHint: null,
                instructions: "Sum up: **$ARGUMENTS**",
                chat: true
            }
        ]);
    });
});

describe("runsInChat", () => {
    it("keeps a command that runs a shell or works on a checkout to Code", () => {
        expect(runsInChat("Save it with `enigma handoff save`, the page on stdin.")).toBe(false);
        expect(runsInChat("```sh\nls\n```")).toBe(false);
        expect(runsInChat("Review the branch's changes.")).toBe(false);
        expect(runsInChat("Improve THIS project.")).toBe(false);
        expect(runsInChat("Answer in three bullet points.")).toBe(true);
    });
});

describe("enigmaCatalogue", () => {
    it("reads a version's package once, and a new version reads its own", async () => {
        const fetcher = vi.fn(async () => TARBALL);
        const first = await enigmaCatalogue("9.0.0", fetcher);
        expect(first.available).toBe(true);
        expect(first.skills.map((entry) => entry.name)).toEqual(["ci-policy", "git-policy"]);
        expect(first.commands.map((entry) => entry.name)).toEqual(["gate", "recap"]);
        await enigmaCatalogue("9.0.0", fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect([...settings.keys()]).toEqual(["enigma.skills.9.0.0", "enigma.commands.9.0.0"]);

        await enigmaCatalogue("9.0.1", fetcher);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher).toHaveBeenLastCalledWith("9.0.1");
        // Only the version in use keeps a stored copy.
        expect([...settings.keys()]).toEqual(["enigma.skills.9.0.1", "enigma.commands.9.0.1"]);
    });

    it("takes a stored copy without asking the registry", async () => {
        settings.set("enigma.skills.9.1.0", JSON.stringify([{ name: "git-policy", description: "d", instructions: "b" }]));
        settings.set("enigma.commands.9.1.0", JSON.stringify([]));
        const fetcher = vi.fn(async () => TARBALL);
        const catalogue = await enigmaCatalogue("9.1.0", fetcher);
        expect(catalogue.skills.map((entry) => entry.name)).toEqual(["git-policy"]);
        expect(catalogue.commands).toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("reads the package once more for commands a copy stored before them lacks", async () => {
        settings.set("enigma.skills.9.1.1", JSON.stringify([{ name: "git-policy", description: "d", instructions: "b" }]));
        const fetcher = vi.fn(async () => TARBALL);
        const catalogue = await enigmaCatalogue("9.1.1", fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(catalogue.commands.map((entry) => entry.name)).toEqual(["gate", "recap"]);
        expect(settings.has("enigma.commands.9.1.1")).toBe(true);
    });

    it("keeps a stored copy's skills when the package cannot be read for its commands", async () => {
        settings.set("enigma.skills.9.1.2", JSON.stringify([{ name: "git-policy", description: "d", instructions: "b" }]));
        const catalogue = await enigmaCatalogue("9.1.2", async () => null);
        expect(catalogue).toMatchObject({ available: true, commands: [] });
        expect(catalogue.skills.map((entry) => entry.name)).toEqual(["git-policy"]);
    });

    it("is an empty, unavailable list while the registry cannot be reached", async () => {
        const fetcher = vi.fn(async (): Promise<Uint8Array | null> => {
            throw new Error("offline");
        });
        expect(await enigmaCatalogue("9.2.0", fetcher)).toEqual({
            version: "9.2.0",
            available: false,
            skills: [],
            commands: []
        });
        await enigmaCatalogue("9.2.0", fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(settings.size).toBe(0);
    });

    it("never fetches a version that is not a plain release number", async () => {
        const fetcher = vi.fn(async () => TARBALL);
        expect((await enigmaCatalogue("../latest", fetcher)).available).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });
});

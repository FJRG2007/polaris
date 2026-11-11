/**
 * Skills from outside: a SKILL.md is read the way the other tools write one,
 * written back so they read it, a GitHub address or a skills.sh page resolves
 * to the files it holds, and nothing a server answers is taken unchecked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const served = new Map<string, string>();
const asked: string[] = [];

vi.mock("@/lib/safe-fetch", () => ({
    safeUrl: (address: string) => {
        try {
            const url = new URL(address);
            return url.protocol === "https:" || url.protocol === "http:" ? url : null;
        } catch {
            return null;
        }
    },
    follow: async (url: URL) => {
        asked.push(url.href);
        const body = served.get(url.href);
        return {
            ok: body !== undefined,
            status: body === undefined ? 404 : 200,
            body: { cancel: async () => undefined },
            text: body ?? ""
        };
    },
    readCapped: async (response: { text: string }) => new TextEncoder().encode(response.text)
}));

const file = await import("@/lib/polar/skills/skill-file");
const remote = await import("@/lib/polar/skills/remote");

const SKILL = [
    "---",
    "name: PDF Forms",
    "description: >",
    "  Fill in PDF forms",
    "  from a list of values.",
    "license: MIT",
    "---",
    "",
    "# Fill a form",
    "",
    "Read every field first."
].join("\n");

beforeEach(() => {
    served.clear();
    asked.length = 0;
});

describe("a SKILL.md", () => {
    it("is read for its name, its description and the instructions under them", () => {
        const found = file.readSkillFile(SKILL, "folder", "origin");
        expect(found.problem).toBeNull();
        expect(found.skill).toEqual({
            name: "pdf-forms",
            description: "Fill in PDF forms from a list of values.",
            instructions: "# Fill a form\n\nRead every field first."
        });
    });

    it("takes its name from where it lies when the file names none", () => {
        const found = file.readSkillFile(
            "---\ndescription: Does a thing\n---\nSteps",
            "Next.js Dev",
            "x"
        );
        expect(found.skill.name).toBe("next-js-dev");
        expect(found.problem).toBeNull();
    });

    it("comes back to be fixed, with its values, when something is missing", () => {
        const found = file.readSkillFile("# Only a heading\n\nAnd text.", "notes", "x");
        expect(found.problem).toBe("invalid");
        expect(found.skill.instructions).toContain("Only a heading");
    });

    it("is refused as too long rather than cut", () => {
        const long = `---\nname: big\ndescription: Big\n---\n${"a".repeat(25_000)}`;
        expect(file.readSkillFile(long, "big", "x").problem).toBe("too_long");
    });

    it("never follows a YAML alias bomb", () => {
        const bomb = `---\na: &a [x, x, x]\nb: &b [*a, *a, *a]\nname: ok\ndescription: fine\n---\nbody`;
        expect(file.readSkillFile(bomb, "fallback", "x").skill.name).toBe("fallback");
    });

    it("is written so it reads back the same, colons and quotes included", () => {
        const skill = {
            name: "reply-email",
            description: 'Use when: a reply is asked for, "quoted" or not.',
            instructions: "Answer every point.\n\n- one\n- two"
        };
        expect(file.readSkillFile(file.skillFileOf(skill), "other", "x").skill).toEqual(skill);
    });
});

describe("an export of many skills", () => {
    it("reads back every skill it holds", () => {
        const skills = [
            { name: "one", description: "First", instructions: "Do one" },
            { name: "two", description: "Second", instructions: "Do two" }
        ];
        const read = file.readSkillBundle(file.skillBundleOf(skills), "polar-skills.json");
        expect(read?.map((entry) => entry.skill)).toEqual(skills);
    });

    it("is not mistaken for any other JSON", () => {
        expect(file.readSkillBundle('{"skills": []}', "x.json")).toBeNull();
        expect(file.readSkillBundle("not json", "x.json")).toBeNull();
    });

    it("marks a name already held, or repeated in the same import", () => {
        const one = file.candidate({ name: "one", description: "a", instructions: "b" }, "1");
        const two = file.candidate({ name: "two", description: "a", instructions: "b" }, "2");
        const marked = file.markDuplicates([one, two, two], new Set(["one"]));
        expect(marked.map((entry) => entry.problem)).toEqual(["duplicate", null, "duplicate"]);
    });
});

describe("an address", () => {
    it("reads every form of a GitHub address", () => {
        expect(remote.repoAddress("https://github.com/anthropics/skills")).toEqual({
            owner: "anthropics",
            repo: "skills",
            ref: "HEAD",
            path: "",
            file: false
        });
        expect(remote.repoAddress("https://github.com/a/b/tree/main/skills/pdf")).toMatchObject({
            ref: "main",
            path: "skills/pdf",
            file: false
        });
        expect(remote.repoAddress("https://github.com/a/b/blob/dev/x/SKILL.md")).toMatchObject({
            ref: "dev",
            path: "x/SKILL.md",
            file: true
        });
        expect(
            remote.repoAddress("https://raw.githubusercontent.com/a/b/main/x/SKILL.md")
        ).toMatchObject({ file: true, path: "x/SKILL.md" });
    });

    it("refuses one that climbs out of the repository or is not GitHub", () => {
        // The address parser already folds "..", so what is left to refuse is a ref.
        expect(remote.repoAddress("https://github.com/a/b/tree/main/../../x")).toBeNull();
        expect(remote.repoAddress("https://github.com/a/b/tree/x..y/z")).toBeNull();
        expect(remote.repoAddress("https://gitlab.com/a/b")).toBeNull();
        expect(remote.repoAddress("javascript:alert(1)")).toBeNull();
    });

    it("reads a skills.sh page as the skill it shows", () => {
        expect(remote.directoryIdOf("https://www.skills.sh/anthropics/skills/pdf")).toBe(
            "anthropics/skills/pdf"
        );
        expect(remote.directoryIdOf("https://skills.sh/docs")).toBeNull();
        expect(remote.isDirectoryId("a/../b")).toBe(false);
    });
});

describe("a repository", () => {
    const tree = (paths: string[]) =>
        JSON.stringify({ tree: paths.map((path) => ({ path, type: "blob" })) });

    it("gives every SKILL.md under the folder asked for", async () => {
        served.set(
            "https://api.github.com/repos/a/b/git/trees/main?recursive=1",
            tree(["README.md", "skills/pdf/SKILL.md", "skills/pdf/run.py", "other/x/SKILL.md"])
        );
        served.set("https://raw.githubusercontent.com/a/b/main/skills/pdf/SKILL.md", SKILL);
        const found = await remote.skillsAt("https://github.com/a/b/tree/main/skills");
        expect(Array.isArray(found) && found.map((entry) => entry.skill.name)).toEqual([
            "pdf-forms"
        ]);
        expect(asked).not.toContain("https://raw.githubusercontent.com/a/b/main/other/x/SKILL.md");
    });

    it("says when a repository holds no skill, or more than one import takes", async () => {
        served.set("https://api.github.com/repos/a/b/git/trees/HEAD?recursive=1", tree(["x.md"]));
        expect(await remote.skillsAt("https://github.com/a/b")).toBe("nothing");
        served.set(
            "https://api.github.com/repos/a/b/git/trees/HEAD?recursive=1",
            tree(Array.from({ length: 31 }, (_, index) => `s${index}/SKILL.md`))
        );
        expect(await remote.skillsAt("https://github.com/a/b")).toBe("too_many");
    });

    it("says when the address does not answer", async () => {
        expect(await remote.skillsAt("https://github.com/a/missing")).toBe("unreachable");
        expect(await remote.skillsAt("not an address")).toBe("address");
    });
});

describe("the skills.sh directory", () => {
    it("is searched, and an answer that does not look right is dropped", async () => {
        served.set(
            "https://skills.sh/api/search?q=pdf&limit=20",
            JSON.stringify({
                skills: [
                    {
                        id: "anthropics/skills/pdf",
                        source: "anthropics/skills",
                        name: "pdf",
                        installs: 9
                    },
                    { id: "../../etc", source: "x", name: "bad", installs: 1 }
                ]
            })
        );
        expect(await remote.searchDirectory("pdf")).toEqual([
            { id: "anthropics/skills/pdf", source: "anthropics/skills", name: "pdf", installs: 9 }
        ]);
        served.set("https://skills.sh/api/search?q=pdf&limit=20", "<html>");
        expect(await remote.searchDirectory("pdf")).toBeNull();
    });

    it("gives a skill from its snapshot, and the worst its audits said", async () => {
        served.set(
            "https://skills.sh/api/download/anthropics/skills/pdf",
            JSON.stringify({ files: [{ path: "SKILL.md", contents: SKILL }] })
        );
        served.set(
            "https://skills.sh/api/v1/skills/audit/anthropics/skills/pdf",
            JSON.stringify({
                audits: [
                    { provider: "Socket", status: "pass" },
                    { provider: "Snyk", status: "warn", riskLevel: "MEDIUM" }
                ]
            })
        );
        const found = await remote.directorySkill("anthropics/skills/pdf");
        expect(typeof found !== "string" && found.skill.name).toBe("pdf-forms");
        expect(await remote.directoryAudit("anthropics/skills/pdf")).toEqual({
            status: "warn",
            flaggedBy: ["Snyk"]
        });
    });
});

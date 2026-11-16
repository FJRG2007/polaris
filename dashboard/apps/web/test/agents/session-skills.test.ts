/**
 * A Code session's skills: which ones it writes (own first, then switched-on
 * built-ins, then only the Enigma skills somebody edited), the body the boot
 * script reads, the script itself, and where the boot runs it - after Enigma
 * installed its copies, which the edits replace. File contents never travel
 * through the boot environment: only the small script does, base64 like every
 * other file there.
 */

import { describe, expect, it } from "vitest";
import * as commands from "@/lib/agents/session-commands";
import { SESSION_SKILL_DIRS, pickSessionSkills, sessionSkillsBody, skillsSyncScript } from "@/lib/agents/session-skills";

const skill = (name: string, instructions = "Body.") => ({ name, description: `Use for ${name}.`, instructions });

describe("pickSessionSkills", () => {
    it("writes own skills, switched-on built-ins and only the edited Enigma skills, own names first", () => {
        const shipped = [skill("security-policy"), skill("git-policy"), skill("commit-message")];
        const effective = [skill("security-policy", "Edited."), skill("git-policy"), skill("commit-message", "Edited too.")];
        const picked = pickSessionSkills({
            own: [skill("commit-message", "Mine.")],
            builtins: [skill("pr-review"), skill("commit-message", "Built-in.")],
            enigmaUpstream: shipped,
            enigmaEffective: effective
        });
        expect(picked.map((entry) => [entry.name, entry.instructions])).toEqual([
            ["commit-message", "Mine."],
            ["pr-review", "Body."],
            ["security-policy", "Edited."]
        ]);
    });

    it("drops a name no skill directory could hold", () => {
        const picked = pickSessionSkills({ own: [skill("../etc"), skill("Bad Name")], builtins: [], enigmaUpstream: [], enigmaEffective: [] });
        expect(picked).toEqual([]);
    });
});

describe("sessionSkillsBody", () => {
    it("is one line per skill with its SKILL.md in base64, of any size", () => {
        const long = "x".repeat(200_000);
        const body = sessionSkillsBody([skill("big", long), skill("small")]);
        const lines = body.trimEnd().split("\n");
        expect(lines).toHaveLength(2);
        const [name, data] = lines[0]!.split("\t");
        expect(name).toBe("big");
        const markdown = Buffer.from(data!, "base64").toString("utf8");
        expect(markdown.startsWith('---\nname: big\ndescription: "Use for big."\n---\n')).toBe(true);
        expect(markdown).toContain(long);
    });
});

describe("skillsSyncScript", () => {
    const script = skillsSyncScript({ url: "https://polaris.example/api/agents/sessions/s1/skills", token: "tok'en" });

    it("fetches with the session's token and writes every agent's skill directory under the home", () => {
        expect(script).toContain("url='https://polaris.example/api/agents/sessions/s1/skills'");
        expect(script).toContain("auth='Authorization: Bearer tok'\\''en'");
        expect(script).toContain('curl -sS -f -m 60 -H "$auth" "$url"');
        for (const dir of SESSION_SKILL_DIRS) expect(script).toContain(dir);
        expect(script).toContain("*[!a-z0-9-]*) continue");
    });

    it("never fails the boot", () => {
        expect(script.trimEnd().endsWith("exit 0")).toBe(true);
        expect(script).not.toMatch(/\bset -e\b/);
    });
});

describe("boot", () => {
    const boot = commands.SESSION_SETUP;
    const run = boot.indexOf("skills-sync.sh\\\" \\\"$POLARIS_HOME");

    it("writes the script from its variable, runs it after Enigma and the memory, and clears the variable", () => {
        expect(boot).toContain("printf %s \"$POLARIS_SKILLS_SYNC\" | base64 -d > \"$POLARIS_STATE_DIR/skills-sync.sh\"");
        expect(run).toBeGreaterThan(0);
        expect(boot.indexOf("polaris-enigma.sh")).toBeLessThan(run);
        expect(boot.indexOf("memory-sync.sh\\\" restore")).toBeLessThan(run);
        expect(boot.slice(run)).toMatch(/unset [^\n]*POLARIS_SKILLS_SYNC/);
    });
});

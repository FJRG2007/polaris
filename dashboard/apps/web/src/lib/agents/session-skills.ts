/**
 * The skills a Code session loads, as the person set them up in Polar: their
 * own switched-on skills, the built-ins they switched on, and every Enigma
 * skill they (or an administrator, for everybody) edited - written over the
 * copy Enigma installed. An Enigma skill nobody edited is left as Enigma
 * installed it.
 *
 * They travel the way the repository's memory does (`session-memory.ts`): the
 * boot writes a small script holding the session's own token, and the script
 * fetches the skills from Polaris before the agent starts. Nothing of any
 * size goes through the boot environment, so a 200 KB skill is as fine as a
 * short one. Pure, so all of it can be asserted.
 */

import { shellQuote } from "@/lib/agents/session-hooks";
import type { ChatSkill } from "@/lib/polar/skills/tools";
import { renderSkillMarkdown } from "@/lib/polar/skills/overrides";

/** Where the agents a session can run read a user's skills, under their home. */
export const SESSION_SKILL_DIRS = [".claude/skills", ".agents/skills", ".config/opencode/skills", ".kimi-code/skills"] as const;

/** The most skills one answer carries: own, built-in and edited Enigma ones. */
const SESSION_SKILLS_MOST = 200;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Which skills a session writes. A person's own skill keeps its name; a
 * built-in or an Enigma skill of the same name steps aside, as in a chat.
 */
export function pickSessionSkills(input: {
    own: readonly ChatSkill[];
    builtins: readonly ChatSkill[];
    /** Enigma's switched-on skills as shipped, and the same list with edits applied. */
    enigmaUpstream: readonly ChatSkill[];
    enigmaEffective: readonly ChatSkill[];
}): ChatSkill[] {
    const out: ChatSkill[] = [];
    const taken = new Set<string>();
    const add = (skill: ChatSkill) => {
        if (taken.has(skill.name) || !NAME.test(skill.name)) return;
        taken.add(skill.name);
        out.push(skill);
    };
    input.own.forEach(add);
    input.builtins.forEach(add);
    for (const skill of input.enigmaEffective) {
        const shipped = input.enigmaUpstream.find((entry) => entry.name === skill.name);
        const edited =
            !shipped || shipped.description !== skill.description || shipped.instructions !== skill.instructions;
        if (edited) add(skill);
    }
    return out.slice(0, SESSION_SKILLS_MOST);
}

/** One line per skill: its name, a tab, and its SKILL.md in base64. */
export function sessionSkillsBody(skills: readonly ChatSkill[]): string {
    return skills
        .filter((skill) => NAME.test(skill.name))
        .map((skill) => `${skill.name}\t${Buffer.from(renderSkillMarkdown(skill.name, skill), "utf8").toString("base64")}\n`)
        .join("");
}

/**
 * The script the boot runs as the agent, with the home Polaris owns as its
 * argument. Best effort: a session whose skills could not be fetched starts
 * with the ones Enigma installed, and says so.
 */
export function skillsSyncScript(paths: { url: string; token: string }): string {
    return [
        "#!/bin/sh",
        "# Written by Polaris. Puts the person's skills, as they set them up in Polar, where the agent reads them.",
        `url=${shellQuote(paths.url)}`,
        `auth=${shellQuote(`Authorization: Bearer ${paths.token}`)}`,
        'home="$1"',
        '[ -n "$home" ] && [ -d "$home" ] || exit 0',
        'state="$(cd "$(dirname "$0")" && pwd)"',
        'tab="$(printf "\\t")"',
        "umask 077",
        'got="$state/skills.$$"',
        'if ! curl -sS -f -m 60 -H "$auth" "$url" -o "$got" 2>/dev/null; then',
        '  rm -f "$got"',
        '  echo "polaris: your skills from Polar could not be fetched, so this session uses the ones Enigma installed"',
        "  exit 0",
        "fi",
        "n=0",
        'while IFS="$tab" read -r name data; do',
        '  case "$name" in ""|-*|*[!a-z0-9-]*) continue ;; esac',
        `  for d in ${SESSION_SKILL_DIRS.join(" ")}; do`,
        '    mkdir -p "$home/$d/$name"',
        '    printf %s "$data" | base64 -d > "$home/$d/$name/SKILL.md" 2>/dev/null || rm -f "$home/$d/$name/SKILL.md"',
        "  done",
        "  n=$((n + 1))",
        'done < "$got"',
        'rm -f "$got"',
        'if [ "$n" -gt 0 ]; then echo "polaris: loaded $n of your skills from Polar"; fi',
        "exit 0",
        ""
    ].join("\n");
}

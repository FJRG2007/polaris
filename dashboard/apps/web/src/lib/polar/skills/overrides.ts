/**
 * Edits layered over skills whose text Polaris does not own: the built-in
 * catalog (`builtin:<id>`) and Enigma's (`enigma:<name>`). An edit is never a
 * copy that stops following its source: it records the upstream text it was
 * made against, so a newer upstream is noticed and offered, and Reset simply
 * drops the edit.
 *
 * Two tiers: the instance (an administrator's edit, for everybody) sits on the
 * shipped text, and a person's own edit sits on top of that. Each tier's
 * "upstream" is whatever is below it.
 *
 * Pure and client-safe: the layering, the diff and the three-way merge are
 * all asserted in tests.
 */

import { z } from "zod";
import { SKILL_DESCRIPTION_MAX } from "@/lib/polar/skills/shared";

/** The `owner` of an instance-wide edit. */
export const INSTANCE_OWNER = "instance";
/** Enigma ships skills of about 110 KB; an edit of one has to fit. */
export const OVERRIDE_INSTRUCTIONS_MAX = 200_000;
/** Lines past which a diff is shown as one replacement instead of computed. */
const DIFF_CELLS_MAX = 4_000_000;

export type UpstreamKind = "builtin" | "enigma";
export type OverrideTier = "user" | "instance";

const KEY = /^(builtin|enigma):([a-z0-9][a-z0-9-]{0,63})$/;

export const skillKeySchema = z.string().regex(KEY);

export function skillKey(kind: UpstreamKind, name: string): string {
    return `${kind}:${name}`;
}

export function parseSkillKey(key: string): { kind: UpstreamKind; name: string } | null {
    const match = KEY.exec(key);
    return match ? { kind: match[1] as UpstreamKind, name: match[2]! } : null;
}

export interface SkillText {
    readonly description: string;
    readonly instructions: string;
}

/** One stored override, as the store reads it. */
export interface OverrideRow {
    readonly description: string | null;
    readonly instructions: string | null;
    readonly baseDescription: string | null;
    readonly baseInstructions: string | null;
}

export interface LayerState {
    /** The text this tier says. */
    readonly text: SkillText;
    /** What was below it when it was written. */
    readonly base: SkillText;
    /** The text below it now differs from `base`. */
    readonly upstreamChanged: boolean;
}

export interface ResolvedSkill extends SkillText {
    /** The shipped text. */
    readonly upstream: SkillText;
    /** What a person's edit sits on: the shipped text with the instance edit applied. */
    readonly belowUser: SkillText;
    readonly instance: LayerState | null;
    readonly user: LayerState | null;
}

const same = (a: SkillText, b: SkillText) =>
    a.description === b.description && a.instructions === b.instructions;

function layer(below: SkillText, row: OverrideRow | null | undefined): LayerState | null {
    if (!row || row.instructions === null || row.description === null) return null;
    const base = {
        description: row.baseDescription ?? below.description,
        instructions: row.baseInstructions ?? below.instructions
    };
    return {
        text: { description: row.description, instructions: row.instructions },
        base,
        upstreamChanged: !same(base, below)
    };
}

/** The text a skill has for one person, with both tiers applied. */
export function resolveSkill(
    upstream: SkillText,
    instance?: OverrideRow | null,
    user?: OverrideRow | null
): ResolvedSkill {
    const instanceLayer = layer(upstream, instance);
    const belowUser = instanceLayer?.text ?? upstream;
    const userLayer = layer(belowUser, user);
    const effective = userLayer?.text ?? belowUser;
    return {
        description: effective.description,
        instructions: effective.instructions,
        upstream,
        belowUser,
        instance: instanceLayer,
        user: userLayer
    };
}

/** What a tier's edit sits on, for a resolved skill. */
export function belowTier(resolved: ResolvedSkill, tier: OverrideTier): SkillText {
    return tier === "user" ? resolved.belowUser : resolved.upstream;
}

/** A short fingerprint of a text, so a save can say which upstream it was made against. */
export function textHash(text: SkillText): string {
    let hash = 0x811c9dc5;
    const input = `${text.description}\u0000${text.instructions}`;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export const overrideTextSchema = z.object({
    description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX),
    instructions: z.string().trim().min(1).max(OVERRIDE_INSTRUCTIONS_MAX)
});

export const saveOverrideSchema = z
    .object({
        skill: skillKeySchema,
        tier: z.enum(["user", "instance"]),
        /** `textHash` of the text below the edit, as the editor saw it. */
        against: z.string().regex(/^[0-9a-f]{8}$/)
    })
    .merge(overrideTextSchema)
    .strict();

export const resetOverrideSchema = z
    .object({ skill: skillKeySchema, tier: z.enum(["user", "instance"]) })
    .strict();

/** Keeps an edit as it is and records the current upstream as what it sits on. */
export const keepOverrideSchema = resetOverrideSchema;

export const builtinEnabledSchema = z
    .object({ skill: skillKeySchema.refine((key) => key.startsWith("builtin:")), enabled: z.boolean() })
    .strict();

/** A skill as SKILL.md spells it: front matter, then the instructions. */
export function renderSkillMarkdown(name: string, text: SkillText): string {
    return [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(text.description)}`,
        "---",
        "",
        text.instructions.trim(),
        ""
    ].join("\n");
}

export type DiffOp = { readonly op: " " | "-" | "+"; readonly line: string };

function splitLines(text: string): string[] {
    return text.replace(/\r\n/g, "\n").split("\n");
}

/** A line diff from `a` to `b`: common ends trimmed, the middle by longest common subsequence. */
export function lineDiff(a: string, b: string): DiffOp[] {
    const left = splitLines(a);
    const right = splitLines(b);
    let head = 0;
    while (head < left.length && head < right.length && left[head] === right[head]) head++;
    let tail = 0;
    while (
        tail < left.length - head &&
        tail < right.length - head &&
        left[left.length - 1 - tail] === right[right.length - 1 - tail]
    )
        tail++;
    const midA = left.slice(head, left.length - tail);
    const midB = right.slice(head, right.length - tail);
    const ops: DiffOp[] = left.slice(0, head).map((line) => ({ op: " ", line }));
    if (midA.length * midB.length > DIFF_CELLS_MAX) {
        ops.push(...midA.map((line) => ({ op: "-" as const, line })));
        ops.push(...midB.map((line) => ({ op: "+" as const, line })));
    } else {
        const n = midA.length;
        const m = midB.length;
        const width = m + 1;
        const table = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i--)
            for (let j = m - 1; j >= 0; j--)
                table[i * width + j] =
                    midA[i] === midB[j]
                        ? table[(i + 1) * width + j + 1]! + 1
                        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (midA[i] === midB[j]) {
                ops.push({ op: " ", line: midA[i]! });
                i++;
                j++;
            } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) ops.push({ op: "-", line: midA[i++]! });
            else ops.push({ op: "+", line: midB[j++]! });
        }
        while (i < n) ops.push({ op: "-", line: midA[i++]! });
        while (j < m) ops.push({ op: "+", line: midB[j++]! });
    }
    ops.push(...left.slice(left.length - tail).map((line) => ({ op: " " as const, line })));
    return ops;
}

/** A unified diff with three lines of context, or "" when nothing differs. */
export function unifiedDiff(a: string, b: string, labels: { from: string; to: string }): string {
    const ops = lineDiff(a, b);
    if (ops.every((entry) => entry.op === " ")) return "";
    const keep = new Array<boolean>(ops.length).fill(false);
    ops.forEach((entry, index) => {
        if (entry.op === " ") return;
        for (let k = Math.max(0, index - 3); k <= Math.min(ops.length - 1, index + 3); k++) keep[k] = true;
    });
    const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
    let aLine = 1;
    let bLine = 1;
    let index = 0;
    while (index < ops.length) {
        if (!keep[index]) {
            if (ops[index]!.op !== "+") aLine++;
            if (ops[index]!.op !== "-") bLine++;
            index++;
            continue;
        }
        const aStart = aLine;
        const bStart = bLine;
        const body: string[] = [];
        while (index < ops.length && keep[index]) {
            const entry = ops[index]!;
            body.push(`${entry.op}${entry.line}`);
            if (entry.op !== "+") aLine++;
            if (entry.op !== "-") bLine++;
            index++;
        }
        const aCount = body.filter((line) => !line.startsWith("+")).length;
        const bCount = body.filter((line) => !line.startsWith("-")).length;
        out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body);
    }
    return out.join("\n");
}

interface Hunk {
    /** First base line replaced. */
    readonly start: number;
    /** One past the last base line replaced (start for a pure insertion). */
    readonly end: number;
    readonly lines: readonly string[];
}

function hunksOf(ops: readonly DiffOp[]): Hunk[] {
    const hunks: Hunk[] = [];
    let base = 0;
    let open: { start: number; end: number; lines: string[] } | null = null;
    for (const entry of ops) {
        if (entry.op === " ") {
            if (open) hunks.push(open);
            open = null;
            base++;
            continue;
        }
        open ??= { start: base, end: base, lines: [] };
        if (entry.op === "-") {
            open.end++;
            base++;
        } else open.lines.push(entry.line);
    }
    if (open) hunks.push(open);
    return hunks;
}

function applyWithin(base: readonly string[], from: number, to: number, hunks: readonly Hunk[]): string[] {
    const out: string[] = [];
    let at = from;
    for (const hunk of hunks) {
        out.push(...base.slice(at, hunk.start), ...hunk.lines);
        at = hunk.end;
    }
    out.push(...base.slice(at, to));
    return out;
}

export interface MergeResult {
    readonly text: string;
    /** Regions both sides changed differently, written with conflict markers. */
    readonly conflicts: number;
}

/**
 * A line-based three-way merge, as diff3 does it: changes on one side only
 * are taken, the same change on both is taken once, and a region both changed
 * differently is written with `<<<<<<<` markers for the person to settle.
 */
export function mergeThree(
    base: string,
    mine: string,
    theirs: string,
    labels: { mine: string; theirs: string }
): MergeResult {
    const baseLines = splitLines(base);
    const ours = hunksOf(lineDiff(base, mine));
    const others = hunksOf(lineDiff(base, theirs));
    const out: string[] = [];
    let conflicts = 0;
    let at = 0;
    let a = 0;
    let b = 0;
    while (a < ours.length || b < others.length) {
        const first =
            b >= others.length || (a < ours.length && ours[a]!.start <= others[b]!.start)
                ? ours[a]!
                : others[b]!;
        let start = first.start;
        let end = first.end;
        const groupOurs: Hunk[] = [];
        const groupOthers: Hunk[] = [];
        // Grow the group while either side has a hunk touching it.
        for (let grew = true; grew; ) {
            grew = false;
            while (a < ours.length && ours[a]!.start <= end) {
                groupOurs.push(ours[a]!);
                start = Math.min(start, ours[a]!.start);
                end = Math.max(end, ours[a]!.end);
                a++;
                grew = true;
            }
            while (b < others.length && others[b]!.start <= end) {
                groupOthers.push(others[b]!);
                start = Math.min(start, others[b]!.start);
                end = Math.max(end, others[b]!.end);
                b++;
                grew = true;
            }
        }
        out.push(...baseLines.slice(at, start));
        const mineSide = applyWithin(baseLines, start, end, groupOurs);
        const theirSide = applyWithin(baseLines, start, end, groupOthers);
        if (groupOthers.length === 0) out.push(...mineSide);
        else if (groupOurs.length === 0) out.push(...theirSide);
        else if (mineSide.join("\n") === theirSide.join("\n")) out.push(...mineSide);
        else {
            conflicts++;
            out.push(`<<<<<<< ${labels.mine}`, ...mineSide, "=======", ...theirSide, `>>>>>>> ${labels.theirs}`);
        }
        at = end;
    }
    out.push(...baseLines.slice(at));
    return { text: out.join("\n"), conflicts };
}

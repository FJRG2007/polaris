/**
 * The ports Polaris hands game servers, and how the router is asked to open them.
 *
 * A game server answers on a port of its own, and until now each one was a fresh
 * trip into the router: two Minecraft servers and a Terraria meant four rules, and
 * the next server meant a fifth. The way out is not to forward everything - an
 * exposed-host entry publishes port 22, hostd and every port any container happens
 * to bind, none of which is a game - but to bound where game ports can land. A
 * block that is declared can be forwarded once, and every server created afterwards
 * is already inside it.
 *
 * The defaults are not a new invention: they are the window the allocator already
 * walked from each edition's canonical port, so an install made before this existed
 * sits inside its block, and the first server of an edition still gets the port its
 * players' clients assume.
 *
 * Pure on purpose: the router instructions are rendered in the browser and import
 * these to write the rule, so nothing here may reach for the database. Reading and
 * writing the operator's choice is `port-block-store.ts`.
 */

import { z } from "zod";

/** The transports a game server can answer on. */
export type PortProtocol = "tcp" | "udp";

/**
 * - `per-port`: one router rule per published port. Exact, and one visit to the
 *               router per server.
 * - `range`   : one rule per transport covering the whole block, so the router is
 *               configured once and every later server is already covered.
 */
export type PortPolicy = "per-port" | "range";

export const PORT_POLICIES: readonly PortPolicy[] = ["per-port", "range"];

/** A contiguous run of ports, inclusive at both ends. */
export interface PortBlock {
    readonly start: number;
    readonly end: number;
}

export type PortBlocks = Readonly<Record<PortProtocol, PortBlock>>;

/**
 * Where each transport's ports come from when nobody has said otherwise.
 *
 * A hundred wide because that is what `availableHostPort` already searched, and
 * starting on the canonical port because a first server on 25565 is one whose
 * address is just the machine - no port to pass on, no SRV record needed.
 */
export const DEFAULT_PORT_BLOCKS: PortBlocks = {
    tcp: { start: 25565, end: 25664 },
    udp: { start: 19132, end: 19231 }
};

/** Polaris' own doors. A block containing them would have the game rules fight
 *  the website rules for the same port, so they are refused rather than sorted
 *  out later. */
const RESERVED_PORTS = [80, 443] as const;

const blockSchema = z
    .object({
        // Below 1024 needs root to bind and is where the protocols everyone else
        // assumes live; a game server has no business in there.
        start: z.number().int().min(1024).max(65535),
        end: z.number().int().min(1024).max(65535)
    })
    // i18n-ignore the form checks with parseBlockInput and says its own sentence; this guards the store
    .refine((block) => block.start <= block.end, { message: "The block starts after it ends" })
    .refine((block) => !RESERVED_PORTS.some((port) => port >= block.start && port <= block.end), {
        // i18n-ignore the form checks with parseBlockInput and says its own sentence; this guards the store
        message: "The block cannot contain 80 or 443, which carry the websites Polaris serves"
    });

export const portPolicySchema = z.enum(["per-port", "range"]);
export const portBlockSchema = blockSchema;

/** Whether a port falls inside a block. */
export function inBlock(port: number, block: PortBlock): boolean {
    return port >= block.start && port <= block.end;
}

/** How many ports a block holds, which is how many servers can fit in it. */
export function blockSize(block: PortBlock): number {
    return block.end - block.start + 1;
}

/** The block as it reads in a rule or a sentence: "25565-25664". */
export function describeBlock(block: PortBlock): string {
    return `${block.start}-${block.end}`;
}

/**
 * A block as it is typed, in the same shape it is displayed in: "25565-25664".
 *
 * Shared by the form and the action on purpose - the field that accepts it and
 * the write that stores it have to agree on what a valid block is, and a second
 * copy of these bounds is a second answer waiting to drift.
 */
export function parseBlockInput(text: string): PortBlock | null {
    const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(text);
    if (!match) return null;
    const parsed = blockSchema.safeParse({ start: Number(match[1]), end: Number(match[2]) });
    return parsed.success ? parsed.data : null;
}

/** A stored block read back, or the default when it is absent or from a version
 *  that allowed something this one does not. */
export function parseBlock(raw: string | null, fallback: PortBlock): PortBlock {
    if (!raw) return fallback;
    try {
        const parsed = blockSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : fallback;
    } catch {
        return fallback;
    }
}

/**
 * How many separate ranges one host may declare per transport. A hosting machine
 * outgrows a single hundred-port window long before it outgrows a router rule
 * per range, and sixteen rules is still a router page somebody can read.
 */
export const PORT_RANGES_MAX = 16;

/** Each transport's ranges on one host, in the order they are walked. */
export type PortRanges = Readonly<Record<PortProtocol, readonly PortBlock[]>>;

/**
 * The first two ranges that share a port, or null when none do. Two ranges that
 * overlap would hand the same port out twice under two rules, so a list with
 * them is refused rather than merged behind the operator's back.
 */
export function overlappingRanges(ranges: readonly PortBlock[]): [PortBlock, PortBlock] | null {
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]!;
        const current = sorted[index]!;
        if (current.start <= previous.end) return [previous, current];
    }
    return null;
}

const rangeListSchema = z
    .array(blockSchema)
    .min(1)
    .max(PORT_RANGES_MAX)
    // i18n-ignore the form checks with parseRangesInput and says its own sentence; this guards the store
    .refine((ranges) => overlappingRanges(ranges) === null, { message: "Two ranges share a port" });

export const portRangesSchema = z.object({ tcp: rangeListSchema, udp: rangeListSchema });

/** The ranges as typed and displayed: "25565-25664, 30000-30999". */
export function describeRanges(ranges: readonly PortBlock[]): string {
    return ranges.map(describeBlock).join(", ");
}

/**
 * A list of ranges as it is typed, separated by commas or new lines. Null when
 * any entry is not a valid block, when there are none or too many, or when two of
 * them overlap - the same rules the store holds, so the field and the write agree.
 */
export function parseRangesInput(text: string): PortBlock[] | null {
    const entries = text
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    if (entries.length === 0 || entries.length > PORT_RANGES_MAX) return null;
    const ranges: PortBlock[] = [];
    for (const entry of entries) {
        const block = parseBlockInput(entry);
        if (!block) return null;
        ranges.push(block);
    }
    return overlappingRanges(ranges) === null ? ranges : null;
}

/** Whether a port falls inside any of the ranges. */
export function inRanges(port: number, ranges: readonly PortBlock[]): boolean {
    return ranges.some((range) => inBlock(port, range));
}

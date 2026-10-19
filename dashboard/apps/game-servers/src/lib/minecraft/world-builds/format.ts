/**
 * The Polaris build: how a seasonal build placed in a server's world is shipped.
 *
 * Builds are converted offline (`convert.ts`) and ship inside Polaris as this
 * format, so nothing is fetched from outside at runtime and no third-party tool
 * is needed on the server: Polaris pastes them with its own commands.
 *
 * The blocks are a palette of block states and the palette index of every cell,
 * run-length encoded as `[index, count, index, count, ...]`, in the order x
 * fastest, then z, then y - the bottom layer first. Index 0 is always air, which
 * is never placed.
 */

import { z } from "zod";
import { DECORATIONS } from "../seasonal";

export const AIR = "minecraft:air";

/** A block state the game's commands take: `minecraft:oak_stairs[facing=east]`. */
const BLOCK_STATE =
    /^[a-z0-9_.-]+:[a-z0-9_./-]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;

/** The largest side a build may have: a site has to be found for it near spawn. */
export const SIDE_MAX = 64;

export const polarisBuildSchema = z
    .object({
        format: z.literal("polaris-build"),
        version: z.literal(1),
        id: z.string().regex(/^[a-z0-9-]{1,48}$/),
        season: z.enum(DECORATIONS),
        size: z.object({
            x: z.number().int().min(1).max(SIDE_MAX),
            y: z.number().int().min(1).max(SIDE_MAX),
            z: z.number().int().min(1).max(SIDE_MAX)
        }),
        palette: z.array(z.string().regex(BLOCK_STATE)).min(1).max(4096),
        blocks: z.array(z.number().int().min(0))
    })
    .superRefine((build, context) => {
        if (build.palette[0] !== AIR)
            context.addIssue({ code: "custom", message: "palette[0] is not air" });
        if (build.blocks.length % 2 !== 0)
            context.addIssue({ code: "custom", message: "runs are not pairs" });
        let cells = 0;
        for (let at = 0; at < build.blocks.length; at += 2) {
            if (build.blocks[at]! >= build.palette.length)
                context.addIssue({
                    code: "custom",
                    message: `index ${build.blocks[at]} outside the palette`
                });
            cells += build.blocks[at + 1]!;
        }
        if (cells !== build.size.x * build.size.y * build.size.z)
            context.addIssue({ code: "custom", message: "runs do not cover the build" });
    });

export type PolarisBuild = z.infer<typeof polarisBuildSchema>;

/** Every cell's palette index, x fastest, then z, then y. */
export function decodeCells(build: PolarisBuild): Uint16Array {
    const cells = new Uint16Array(build.size.x * build.size.y * build.size.z);
    let at = 0;
    for (let run = 0; run < build.blocks.length; run += 2) {
        cells.fill(build.blocks[run]!, at, at + build.blocks[run + 1]!);
        at += build.blocks[run + 1]!;
    }
    return cells;
}

/** The runs of a list of cells, as `blocks` keeps them. */
export function encodeCells(cells: ArrayLike<number>): number[] {
    const runs: number[] = [];
    for (let at = 0; at < cells.length; at += 1) {
        if (runs.length > 0 && runs[runs.length - 2] === cells[at]) runs[runs.length - 1]! += 1;
        else runs.push(cells[at]!, 1);
    }
    return runs;
}

/** A block state's block, without its properties: what a teardown replaces. */
export function blockOf(state: string): string {
    const open = state.indexOf("[");
    return open === -1 ? state : state.slice(0, open);
}

/**
 * The mazes in hide and seek's manor (`seek-rooms.ts`): a grid of cells carved
 * by the recursive backtracker - a depth-first walk that knocks through to a
 * random unvisited neighbour and backs up at a dead end, which gives long
 * winding corridors and plenty of dead ends - then braided a little: a few walls
 * between neighbouring cells knocked through at random so it is not a pure tree
 * and there is more than one way round (Jamis Buck, "Mazes for Programmers",
 * 2015, chapters 3 and 9).
 *
 * Pure: the same random source carves the same maze.
 */

export interface Maze {
    readonly cells: number;
    /** Whether the wall east of (x, z) is open, and south of it. */
    readonly east: readonly boolean[];
    readonly south: readonly boolean[];
}

const at = (cells: number, x: number, z: number) => z * cells + x;

/** A maze `cells` by `cells`, every cell reachable from every other, with
 *  about `loops` of the walls left standing knocked through again. */
export function carve(cells: number, random: () => number, loops = 0.12): Maze {
    const east = new Array<boolean>(cells * cells).fill(false);
    const south = new Array<boolean>(cells * cells).fill(false);
    const seen = new Array<boolean>(cells * cells).fill(false);
    const stack: [number, number][] = [[Math.floor(random() * cells), Math.floor(random() * cells)]];
    seen[at(cells, ...stack[0]!)] = true;
    while (stack.length > 0) {
        const [x, z] = stack.at(-1)!;
        const next = (
            [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ] as const
        )
            .map(([dx, dz]) => [x + dx, z + dz] as [number, number])
            .filter(
                ([nx, nz]) =>
                    nx >= 0 && nz >= 0 && nx < cells && nz < cells && !seen[at(cells, nx, nz)]
            );
        if (next.length === 0) {
            stack.pop();
            continue;
        }
        const [nx, nz] = next[Math.floor(random() * next.length)]!;
        if (nx !== x) east[at(cells, Math.min(x, nx), z)] = true;
        else south[at(cells, x, Math.min(z, nz))] = true;
        seen[at(cells, nx, nz)] = true;
        stack.push([nx, nz]);
    }
    for (let z = 0; z < cells; z += 1)
        for (let x = 0; x < cells; x += 1) {
            if (x + 1 < cells && random() < loops) east[at(cells, x, z)] = true;
            if (z + 1 < cells && random() < loops) south[at(cells, x, z)] = true;
        }
    return { cells, east, south };
}

/** Whether a wall stands between a cell and its neighbour. */
export function open(maze: Maze, x: number, z: number, dx: number, dz: number): boolean {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= maze.cells || nz >= maze.cells) return false;
    if (dx !== 0) return maze.east[at(maze.cells, Math.min(x, nx), z)]!;
    return maze.south[at(maze.cells, x, Math.min(z, nz))]!;
}

/** The cells with one way out: where the hiding places go. */
export function deadEnds(maze: Maze): [number, number][] {
    const out: [number, number][] = [];
    for (let z = 0; z < maze.cells; z += 1)
        for (let x = 0; x < maze.cells; x += 1) {
            const ways = (
                [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ] as const
            ).filter(([dx, dz]) => open(maze, x, z, dx, dz)).length;
            if (ways === 1) out.push([x, z]);
        }
    return out;
}

/** Every cell reached from (0, 0) through open walls: all of them, carved. */
export function reached(maze: Maze): number {
    const seen = new Set<number>([0]);
    const queue: [number, number][] = [[0, 0]];
    while (queue.length > 0) {
        const [x, z] = queue.pop()!;
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const)
            if (open(maze, x, z, dx, dz) && !seen.has(at(maze.cells, x + dx, z + dz))) {
                seen.add(at(maze.cells, x + dx, z + dz));
                queue.push([x + dx, z + dz]);
            }
    }
    return seen.size;
}

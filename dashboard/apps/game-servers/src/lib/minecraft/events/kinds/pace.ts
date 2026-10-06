import * as stage from "./stage";
import type { ServerContainer } from "../../service";

/**
 * How fast an event goes from one step to the next, and how much of the
 * server's time one trip into it may take.
 *
 * The game answers a command in well under a millisecond; what costs is the trip
 * into the container to give it one - tens of milliseconds, more on a machine
 * reached over SSH - and the event loop's tick of two seconds between steps. So
 * a step that has nothing to wait for runs straight after the one before, in
 * the same tick, and what several players each need is asked in one trip
 * rather than one trip each.
 *
 * Only ever the commands every supported server takes - vanilla, Paper, Fabric,
 * Forge, any version an event runs on: nothing here needs a mod or a data pack.
 */

/** How many steps towards "Go!" one tick may take, at most. */
export const STEPS_AT_ONCE = 6;

/**
 * How long chunks just held (`forceload add`) are given before they are counted,
 * inside the same tick: a few game ticks, enough for ground already generated.
 * Ground that takes longer is waited for a tick at a time, as it always was.
 */
export const LOAD_PAUSE_MS = 250;

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block work, sent a trip at a time so no trip holds the server's main thread
 * for long: every command in a trip runs on it before it gets on with the game.
 *
 * Starts at `start` blocks a trip, and follows what the trips actually cost: a
 * trip that took the server much longer than the quickest one seen - its own
 * work, since the way there is the same - halves the next; a quick one lets it
 * grow again, never past `most` nor under `least`. A modded server with a slow
 * tick therefore gets smaller trips without being asked to report its tick.
 */
export interface Pacer {
    /** The next trip: as many of `items`, from the front, as its share allows. */
    take<T>(items: readonly T[], volumeOf: (item: T) => number): T[];
    /** Time a trip, so the next one is sized by it. */
    timed<R>(trip: () => Promise<R>): Promise<R>;
}

/** Above this much more than the quickest trip, the server was busy with it. */
export const SLOW_TRIP_MS = 100;
/** Up to this much more, it was not, and the next trip may carry more. */
const QUICK_TRIP_MS = 25;
/** Never more lines in one trip than this, however small each is. */
const LINES_PER_TRIP = 25;

export function pacer(start: number, least: number, most: number): Pacer {
    let share = start;
    let quickest = Number.POSITIVE_INFINITY;
    return {
        take(items, volumeOf) {
            const out: (typeof items)[number][] = [];
            let volume = 0;
            for (const item of items) {
                const size = volumeOf(item);
                // One line too big for a share still goes, on its own.
                if (out.length > 0 && (volume + size > share || out.length >= LINES_PER_TRIP))
                    break;
                out.push(item);
                volume += size;
            }
            return out;
        },
        async timed(trip) {
            const from = Date.now();
            const result = await trip();
            const took = Date.now() - from;
            quickest = Math.min(quickest, took);
            const over = took - quickest;
            if (over > SLOW_TRIP_MS) share = Math.max(least, Math.floor(share / 2));
            else if (over <= QUICK_TRIP_MS) share = Math.min(most, share * 2);
            return result;
        }
    };
}

/** How many blocks a `fill` line covers; 1 for any other line. */
export function fillVolume(line: string): number {
    const box = / fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) /.exec(` ${line}`);
    if (!box) return 1;
    const [x1, y1, z1, x2, y2, z2] = box.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number
    ];
    return (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
}

/**
 * `lines` sent a paced trip at a time (`Pacer`), each trip answered through
 * `send`: block work that never takes more of the server's time in one go than
 * the pacer allows.
 */
export async function inTrips<R>(
    lines: readonly string[],
    pacing: Pacer,
    send: (trip: string[]) => Promise<R>
): Promise<R[]> {
    const out: R[] = [];
    for (let from = 0; from < lines.length; ) {
        const trip = pacing.take(lines.slice(from), fillVolume);
        out.push(await pacing.timed(() => send(trip)));
        from += trip.length;
    }
    return out;
}

/** One `fill`'s most, as the game allows it (`arena.VOLUME_MAX`). */
const ONE_FILL = 32_768;

/**
 * Blocks placed in one trip: one whole fill's worth to start with, two at most,
 * an eighth of one on a server that is struggling. Placing is the heavy part -
 * light and neighbours updated for every block - so it is held to the size the
 * game itself takes in one command.
 */
export function buildPacer(): Pacer {
    return pacer(ONE_FILL, ONE_FILL / 8, ONE_FILL * 2);
}

/**
 * Blocks looked at in one trip to take an arena down: every position of a
 * `fill ... air replace <block>` is read, and only ours change, so a trip may
 * cover more than a build's - eight whole fills to start with, the twenty-five
 * the teardown always sent at most, one on a struggling server.
 */
export function teardownPacer(): Pacer {
    return pacer(ONE_FILL * 8, ONE_FILL, ONE_FILL * 25);
}

/**
 * How much one trip of `coalescing` asks: the commands go into the trip's own
 * shell script, kept to the size a batch of lines is (`service.BATCH_MAX`).
 * What comes back is cut at 16 KiB (`say-each`); answers past the cut are
 * asked again together in the next trip, so a trip's worth of big bags costs
 * another trip, not one each.
 */
const SCRIPT_PER_TRIP = 12_000;
/** What `sayEachScript` adds around each command. */
const SCRIPT_PER_COMMAND = 60;

/** How many turns of the promise queue a trip waits to gather questions. */
const GATHER_HOPS = 32;

/**
 * Plain reads of one player that answer the same through `sayEach` as through
 * `say`: nothing in them for the language split, the paged read of everybody,
 * or the chunks somebody else holds (`events-service`, `chunks.sparing`).
 */
const PLAIN_READ =
    /^(data get entity [A-Za-z0-9_]{1,16}\b|xp query [A-Za-z0-9_]{1,16} |execute (if|unless) (entity|block|score) |execute as [A-Za-z0-9_]{1,16} at @s if )/;

/**
 * The same server, with what several callers ask at the same time sent in one
 * trip: the plain reads of `PLAIN_READ` through `sayEach`, and every `sayAll`
 * one after another in a single batch. Whatever is asked while a trip is on its
 * way goes in the next one, so players handled side by side share their trips
 * the whole way through - one trip per step for everybody, not one each.
 *
 * Each caller's own commands keep their order, and answer exactly as alone: an
 * answer that did not come back whole is asked again - with the others that
 * missed the same trip, then on its own. Anything else
 * goes as it always did. A server without `sayEach` (Bedrock) is unchanged.
 */
export function coalescing(server: ServerContainer): ServerContainer {
    const sayEach = server.sayEach;
    if (!sayEach) return server;
    interface Ask {
        readonly argv: readonly string[];
        readonly alone: boolean;
        /** Asked again already, after missing a trip's cut. */
        readonly retried?: boolean;
        readonly done: (answer: string | null) => void;
        readonly failed: (error: unknown) => void;
    }
    interface Lines {
        readonly lines: readonly string[];
        readonly done: () => void;
        readonly failed: (error: unknown) => void;
    }
    let asks: Ask[] = [];
    let batches: Lines[] = [];
    let sending = false;

    const send = async (): Promise<void> => {
        while (batches.length > 0 || asks.length > 0) {
            if (batches.length > 0) {
                const going = batches;
                batches = [];
                try {
                    await server.sayAll(going.flatMap((one) => one.lines));
                    for (const one of going) one.done();
                } catch (error) {
                    for (const one of going) one.failed(error);
                }
                continue;
            }
            const going: Ask[] = [];
            let script = 0;
            while (asks.length > 0) {
                const size = asks[0]!.argv.join(" ").length + SCRIPT_PER_COMMAND;
                if (going.length > 0 && script + size > SCRIPT_PER_TRIP) break;
                script += size;
                going.push(asks.shift()!);
            }
            try {
                const answers = await sayEach(going.map((one) => one.argv));
                const again: Ask[] = [];
                for (const [at, one] of going.entries()) {
                    const answer = answers[at] ?? null;
                    // Past what the trip could hand back: asked again together
                    // with the rest that missed it, before anything newer.
                    if (answer === null && !one.retried && at > 0)
                        again.push({ ...one, retried: true });
                    else if (answer !== null || !one.alone) one.done(answer);
                    else
                        server.say(one.argv).then(
                            (said) => one.done(said),
                            (error: unknown) => one.failed(error)
                        );
                }
                asks = [...again, ...asks];
            } catch (error) {
                for (const one of going) one.failed(error);
            }
        }
        sending = false;
    };
    const start = () => {
        if (sending) return;
        sending = true;
        // Whatever the others ask on their way to the same step goes in the
        // same trip: their answers arrived together, and each is a few awaits
        // from its next question. Nothing waits on a timer.
        void (async () => {
            for (let hop = 0; hop < GATHER_HOPS; hop += 1) await Promise.resolve();
            await send();
        })();
    };
    const ask = (argv: readonly string[], alone: boolean) =>
        new Promise<string | null>((done, failed) => {
            asks.push({ argv, alone, done, failed });
            start();
        });
    return {
        ...server,
        say: async (argv) => {
            if (!PLAIN_READ.test(argv.join(" "))) return server.say(argv);
            return (await ask(argv, true)) ?? "";
        },
        sayAll: (lines) =>
            lines.length === 0
                ? Promise.resolve()
                : new Promise<void>((done, failed) => {
                      batches.push({ lines, done, failed });
                      start();
                  }),
        sayEach: (commands) => Promise.all(commands.map((argv) => ask(argv, false)))
    };
}

/**
 * Each of `lines`' answers, in order, a paced trip at a time (`inTrips`) where
 * the server takes several in one (`sayEach`), and one at a time where it does
 * not. An answer that did not come back whole is asked again on its own; a trip
 * that failed outright throws, since its commands may still be running.
 */
export async function answered(
    server: ServerContainer,
    lines: readonly string[],
    pacing: Pacer
): Promise<string[]> {
    const out: string[] = [];
    if (!server.sayEach) {
        for (const line of lines) out.push(await server.say([line]));
        return out;
    }
    const sayEach = server.sayEach;
    await inTrips(lines, pacing, async (trip) => {
        const replies = await sayEach(trip.map((line) => [line]));
        for (const [at, line] of trip.entries())
            out.push(replies[at] ?? (await server.say([line])));
    });
    return out;
}

/** The chunk columns a box touches, as `x z` block corners of each. */
function columnsOf(box: { x1: number; z1: number; x2: number; z2: number }): [number, number][] {
    const columns: [number, number][] = [];
    const from = (a: number, b: number) => Math.floor(Math.min(a, b) / 16);
    const to = (a: number, b: number) => Math.floor(Math.max(a, b) / 16);
    for (let x = from(box.x1, box.x2); x <= to(box.x1, box.x2); x += 1)
        for (let z = from(box.z1, box.z2); z <= to(box.z1, box.z2); z += 1)
            columns.push([x * 16, z * 16]);
    return columns;
}

/** No more chunk columns than this are asked about at once. */
const COLUMNS_ASKED = 64;

/**
 * Whether every chunk under `box` is loaded now, asked in one trip: a fill of
 * one block of air over air in each column - which changes nothing and answers
 * "No blocks were filled" where the chunk is in, and "not loaded" where it is
 * not. False where it cannot be asked in one trip, so the caller takes the
 * slow, one-at-a-time way it always did.
 */
export async function allLoaded(
    server: ServerContainer,
    box: { x1: number; y1: number; z1: number; x2: number; z2: number }
): Promise<boolean> {
    const columns = columnsOf(box);
    if (!server.sayEach || columns.length > COLUMNS_ASKED) return false;
    const y = box.y1;
    const replies = await server
        .sayEach(
            columns.map(([x, z]) => [
                `execute in minecraft:overworld run fill ${x} ${y} ${z} ${x} ${y} ${z} minecraft:air replace minecraft:air`
            ])
        )
        .catch(() => null);
    return (
        replies !== null &&
        replies.every((reply) => reply !== null && stage.fillCount(reply) !== null)
    );
}

/**
 * The same server, with `lines` - reads a step may make one after another,
 * each depending on the last only for whether it is asked - all asked in one
 * trip the first time any of them is, and each answered from that trip once.
 * A second read of the same line, or one whose answer did not come back whole,
 * is asked live. A step that never reads any of them costs nothing more.
 */
export function prefetching(server: ServerContainer, lines: readonly string[]): ServerContainer {
    const sayEach = server.sayEach;
    if (!sayEach) return server;
    let read: Promise<Map<string, string>> | null = null;
    return {
        ...server,
        say: async (argv) => {
            const line = argv.join(" ");
            if (!lines.includes(line)) return server.say(argv);
            read ??= sayEach(lines.map((one) => [one])).then(
                (answers) =>
                    new Map(
                        lines.flatMap((one, at) => {
                            const answer = answers[at];
                            return typeof answer === "string" ? [[one, answer] as const] : [];
                        })
                    ),
                () => new Map<string, string>()
            );
            const answers = await read;
            const answer = answers.get(line);
            if (answer === undefined) return server.say(argv);
            answers.delete(line);
            return answer;
        }
    };
}

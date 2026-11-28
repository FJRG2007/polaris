/**
 * What a handheld does when it loses the venue's network for a moment: the
 * order it was sending waits in a queue on the device and goes out, in order,
 * when the network is back.
 *
 * Replaying is safe because every write carries ids the device made (the
 * order's, each line's, each payment's): the server stores an id once, so a
 * request that did arrive before the connection dropped changes nothing when
 * it is sent again. Totals and prices are never queued - the server works
 * them out when the write lands.
 *
 * An operation leaves the queue when the server answers it, either way: an
 * accepted one is done, a refused one (sold out, order closed) is handed back
 * to be shown, since sending it again would be refused again. A request that
 * never got an answer stays, and so does one the server failed on its own side
 * (`retry`, the database restarting under an update) for up to
 * `RETRY_WINDOW_MS`; either blocks the ones behind it so a send never
 * overtakes the lines it sends.
 *
 * Pure: the store and the transport are passed in, so the tests drive it
 * without a browser.
 */

export interface QueuedOp {
    /** Unique per operation; enqueueing the same id twice keeps one. */
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly queuedAt: number;
}

export interface QueueStore {
    all(): Promise<QueuedOp[]>;
    put(op: QueuedOp): Promise<void>;
    remove(id: string): Promise<void>;
}

/** How the server answered: accepted, refused with a sentence, or no answer at all. */
export type Delivery = { readonly status: "ok" } | { readonly status: "refused"; readonly error: string } | { readonly status: "offline" };

export type Transport = (op: QueuedOp) => Promise<Delivery>;

/** How long a write the server failed on (not refused) is kept and sent again.
 *  Longer than an update takes to roll the dashboard and its database over;
 *  past it the failure is handed back, so one broken write cannot hold the
 *  device's queue for the rest of the service. */
export const RETRY_WINDOW_MS = 10 * 60 * 1000;

/** What an action answered, as the queue reads it. */
export interface ActionAnswer {
    readonly ok: boolean;
    readonly error?: string;
    /** The server failed on its own side; the write was not judged. */
    readonly retry?: boolean;
}

export function deliveryOf(answer: ActionAnswer, op: Pick<QueuedOp, "queuedAt">, now = Date.now()): Delivery {
    if (answer.ok) return { status: "ok" };
    if (answer.retry && now - op.queuedAt < RETRY_WINDOW_MS) return { status: "offline" };
    return { status: "refused", error: answer.error ?? "" };
}

export async function enqueue(store: QueueStore, op: QueuedOp): Promise<void> {
    const ops = await store.all();
    if (ops.some((o) => o.id === op.id)) return;
    await store.put(op);
}

export interface FlushResult {
    readonly sent: number;
    readonly refused: ReadonlyArray<{ op: QueuedOp; error: string }>;
    /** Still waiting for the network. */
    readonly left: number;
}

/** Sends what is queued, oldest first, stopping at the first one with no answer. */
export async function flush(store: QueueStore, send: Transport): Promise<FlushResult> {
    const ops = (await store.all()).sort((a, b) => a.queuedAt - b.queuedAt);
    let sent = 0;
    const refused: Array<{ op: QueuedOp; error: string }> = [];
    for (const [i, op] of ops.entries()) {
        let delivery: Delivery;
        try {
            delivery = await send(op);
        } catch {
            delivery = { status: "offline" };
        }
        if (delivery.status === "offline") return { sent, refused, left: ops.length - i };
        await store.remove(op.id);
        if (delivery.status === "ok") sent += 1;
        else refused.push({ op, error: delivery.error });
    }
    return { sent, refused, left: 0 };
}

/** A store in memory, for the tests and for a browser with storage blocked. */
export function memoryStore(): QueueStore {
    const ops = new Map<string, QueuedOp>();
    return {
        all: async () => [...ops.values()],
        put: async (op) => void ops.set(op.id, op),
        remove: async (id) => void ops.delete(id)
    };
}

/**
 * Reading a request's body without agreeing to hold whatever arrives.
 *
 * A route handler has no body limit of its own, so `arrayBuffer()` and
 * `formData()` allocate everything that is sent before anything can decide it
 * was too much - a client sending two gigabytes gets the allocation, and the
 * refusal written under it never runs. `content-length` does not help either:
 * it is the sender's claim, and a request may not carry one at all.
 *
 * So every route that takes bytes reads them through here, and the most that is
 * ever held is the limit plus the chunk that crossed it.
 */

/** The body, read no further than `most` bytes, or `null` once it is past that.
 *  A request with no body at all reads as an empty one, which is a different
 *  answer and each caller says so in its own words. */
export async function readCappedBody(request: Request, most: number): Promise<Uint8Array | null> {
    if (!request.body) return new Uint8Array(0);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let held = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            held += value.byteLength;
            if (held > most) return null;
            chunks.push(value);
        }
    } finally {
        // Nothing more is wanted, whether the body ended or was refused. On a
        // refusal this is what stops the sender rather than reading the rest of
        // it into a buffer that is already being thrown away.
        void reader.cancel().catch(() => {});
    }

    const body = new Uint8Array(held);
    let at = 0;
    for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.byteLength;
    }
    return body;
}

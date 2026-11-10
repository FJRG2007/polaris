/** A streamed answer as a response body, kept open while the model is quiet. Pure. */

/** How long a stream may stay silent before a keep-alive goes out. A model
 *  thinking without streaming its thoughts can be quiet for minutes, and a
 *  proxy in between closes an idle connection long before that. */
export const KEEP_ALIVE_MS = 15_000;

/** An SSE comment: every SSE reader skips it (html.spec.whatwg.org,
 *  server-sent events), so it keeps an OpenAI-style stream open without an
 *  event the client has to know. */
export const SSE_COMMENT = ": keep-alive\n\n";

/**
 * A frame generator as a streamed response body. While the next frame is
 * slow in coming, `keepAlive` goes out every `every` milliseconds: the
 * Anthropic stream has its own `ping` event for this, the OpenAI streams a
 * comment.
 */
export function streamBody<Frame>(
    frames: AsyncGenerator<Frame>,
    encode: (frame: Frame) => string,
    keepAlive: string = SSE_COMMENT,
    every: number = KEEP_ALIVE_MS
): ReadableStream {
    const encoder = new TextEncoder();
    let pending: Promise<IteratorResult<Frame>> | null = null;
    return new ReadableStream({
        async pull(controller) {
            try {
                pending ??= frames.next();
                let timer: ReturnType<typeof setTimeout> | undefined;
                const tick = new Promise<"tick">((resolve) => {
                    timer = setTimeout(() => resolve("tick"), every);
                });
                const next = await Promise.race([pending, tick]);
                clearTimeout(timer);
                if (next === "tick") {
                    controller.enqueue(encoder.encode(keepAlive));
                    return;
                }
                pending = null;
                if (next.done) controller.close();
                else controller.enqueue(encoder.encode(encode(next.value)));
            } catch (error) {
                console.error("polar api: stream failed", error instanceof Error ? error.message : error);
                controller.close();
            }
        },
        async cancel() {
            await frames.return(undefined);
        }
    });
}

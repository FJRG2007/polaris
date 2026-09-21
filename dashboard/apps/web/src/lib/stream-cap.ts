/**
 * A limit on a body nobody is holding.
 *
 * The point of streaming an upload is that the file never exists in this
 * process's memory, which also means its size is not something that can be
 * checked before the write: `content-length` is what the client said, and a
 * client that can say a number can say a smaller one than it sends. So the limit
 * is counted as the bytes go past, and the stream is failed the moment the count
 * is exceeded - with nothing buffered and the rest of the upload never read.
 *
 * A write that was cut off this way leaves a truncated file behind under a name
 * that reads like a whole one, so every caller deletes what it was writing when
 * this throws. That is the caller's because only it knows where the bytes were
 * going.
 *
 * The error carries `TOO_LARGE` as its message rather than a sentence, because
 * the two things that need to say this - a conversation and a public drop point -
 * say it to very different readers, in their own words.
 */

/** What a capped stream rejects with once the count is past the limit. */
export const TOO_LARGE = "too_large";

/** Whether a failure was this one, rather than the storage or the network. */
export function wasTooLarge(error: unknown): boolean {
    return error instanceof Error && error.message === TOO_LARGE;
}

/**
 * The same bytes, and an error instead of the byte that goes over the limit.
 *
 * @param max The most that may pass through, in bytes. Zero or less lets
 *   everything through: a limit of "none" is a real answer here, and a cap of
 *   zero that rejected the first byte would be an upload that silently stopped
 *   working the day somebody turned the limit off.
 */
export function cappedStream(
    body: ReadableStream<Uint8Array>,
    max: number
): ReadableStream<Uint8Array> {
    if (!Number.isFinite(max) || max <= 0) return body;
    let seen = 0;
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            seen += value.byteLength;
            if (seen > max) {
                // Nothing further is read: the rest of the upload is abandoned
                // rather than received and thrown away.
                await reader.cancel(TOO_LARGE).catch(() => undefined);
                controller.error(new Error(TOO_LARGE));
                return;
            }
            controller.enqueue(value);
        },
        async cancel(reason) {
            await reader.cancel(reason);
        }
    });
}

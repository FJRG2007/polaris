/**
 * Handing a driver's lifetime to the response that is streaming its bytes.
 *
 * A route that returns `driver.readStream(...)` has nothing left to await: the
 * bytes leave long after the handler returned, so disposing in a `finally` would
 * pull the session out from under the transfer, and not disposing at all leaks it.
 * Sessions are pooled now, and a lease that never comes back pins its connection
 * for the life of the process - one more per download.
 */

/** Wrap a body stream so the driver is disposed once the response finishes,
 *  whether it ran to the end or the client walked away. */
export function pipeThenDispose(
    stream: ReadableStream<Uint8Array>,
    driver: { dispose(): Promise<void> }
): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    let disposed = false;
    const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        await driver.dispose();
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let read;
            try {
                read = await reader.read();
            } catch (error) {
                // A transfer that broke mid-file still has to give the session back;
                // the consumer is told what happened by the rejection.
                await dispose();
                throw error;
            }
            if (read.done) {
                controller.close();
                await dispose();
                return;
            }
            controller.enqueue(read.value);
        },
        async cancel(reason) {
            // The source's own cancel can fail; the session still has to come back.
            try {
                await reader.cancel(reason);
            } finally {
                await dispose();
            }
        }
    });
}

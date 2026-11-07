// Starting the graphics without ever waiting forever. A browser whose WebGPU answers neither yes nor no - the adapter or
// device request never settles, which is what some desktop shells and GPU drivers do - left the city on "Building the
// city" for good: three.js falls back to WebGL 2 only when WebGPU says no. So WebGPU gets a few seconds, then the page
// starts again on WebGL 2; and when that does not answer either, the load fails with the graphics named, like any
// browser without them.

/** How long WebGPU may take to come up before WebGL 2 takes its place. It takes well under a second when it works. */
export const WEBGPU_START_MS = 8000;

/** How long WebGL 2, which starts at once or not at all, may take. */
export const WEBGL_START_MS = 8000;

function withinTime(promise, ms) {
    let timer;
    const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`graphics did not start within ${ms} ms`)), ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * A renderer that has started: `create(forceWebGL)` makes one (and puts its canvas on the page), and the first one is
 * given `webgpuMs` to start before it is taken off the page and a WebGL 2 one is made in its place. Rejects when no
 * renderer starts.
 */
export async function startRenderer(
    create,
    { webgpuMs = WEBGPU_START_MS, webglMs = WEBGL_START_MS } = {}
) {
    const first = create(false);
    const firstStarted = first.init();
    try {
        await withinTime(firstStarted, webgpuMs);
        return first;
    } catch (error) {
        // A WebGPU that said no has already been replaced by WebGL 2 inside three.js; only one that never answered gets here
        // still on WebGPU, and one whose WebGL 2 failed has nothing left to try.
        if (!first.backend?.isWebGPUBackend) throw error;
        console.warn(`[gpu] WebGPU did not start (${error.message}), starting on WebGL 2`);
        first.domElement?.remove();
        firstStarted.then(
            () => first.dispose?.(),
            () => first.dispose?.()
        );
    }
    const fallback = create(true);
    await withinTime(fallback.init(), webglMs);
    return fallback;
}

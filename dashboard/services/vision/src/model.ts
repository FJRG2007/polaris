/**
 * The detection model, and the contract with the file on disk.
 *
 * One session, loaded once and used for every camera this worker watches. The
 * model is small enough that a home server can run it on the CPU, and the
 * session is what holds the memory it needs, so sharing it matters: one per
 * camera would be the same weights loaded four times.
 *
 * The file is not trusted to be the model this code was written for. Its input
 * and output shapes are checked when it loads, and a file that does not match
 * is refused rather than half-read - because the failure mode of a model with a
 * different output layout is not an error, it is boxes in the wrong part of the
 * picture, which nobody notices until they compare a still with what was drawn
 * on it.
 */

import * as ort from "onnxruntime-node";
import { candidateCount, ROW_LENGTH } from "@polaris/core";

/**
 * The square this worker feeds a model, in pixels.
 *
 * Fixed rather than read off the file, because a model that takes a different
 * square is not simply a bigger version of this one - the grids the decoder
 * walks are derived from it, and a mismatch is silently wrong rather than an
 * error. A file that will not take this square is refused.
 */
const MODEL_SIZE = 416;

export interface LoadedModel {
    /** The side of the square it takes, in pixels. */
    readonly size: number;
    /** One frame in the model's own convention - the square, blue-green-red,
     *  one byte a channel - and the raw output tensor back. */
    run(frame: Uint8Array): Promise<Float32Array>;
    close(): Promise<void>;
}

/** Dimensions come back as numbers for a fixed axis and as a name for a dynamic
 *  one, so anything that is not a number is not a size. */
function fixedDims(dims: readonly (number | string)[]): number[] | null {
    const numbers = dims.map((value) => (typeof value === "number" ? value : Number.NaN));
    return numbers.every((value) => Number.isInteger(value) && value > 0) ? numbers : null;
}

/**
 * Open the model, or say why not.
 *
 * Returns null rather than throwing: a worker whose model is missing must still
 * watch for movement, which is the rung below and the one that needs nothing.
 * A camera asking for more than that reports movement instead, which is worse
 * than it was promised and much better than silence.
 */
export async function loadModel(path: string): Promise<LoadedModel | null> {
    let session: ort.InferenceSession;
    try {
        session = await ort.InferenceSession.create(path, {
            executionProviders: ["cpu"],
            graphOptimizationLevel: "all",
            // One thread per session on purpose. This shares a home server with
            // whatever else the owner put on it, and a detector that takes every
            // core for the fifth of a second it runs is a detector that makes
            // everything else stutter.
            intraOpNumThreads: 1
        });
    } catch (error) {
        console.error(`[vision] could not open the model at ${path}: ${String(error)}`);
        return null;
    }

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) {
        console.error("[vision] the model has no input or no output");
        return null;
    }

    // onnxruntime does not expose declared shapes on the session, so the shape
    // is established by running one empty frame through it. It costs a fifth of
    // a second, once, at startup - and it is the only way to be certain that the
    // file on disk answers in the layout the decoder expects.
    const size = MODEL_SIZE;
    let rows = 0;
    try {
        const probe = new ort.Tensor("float32", new Float32Array(3 * size * size), [1, 3, size, size]);
        const result = await session.run({ [inputName]: probe });
        const output = result[outputName];
        const dims = output ? fixedDims(output.dims) : null;
        if (!dims || dims.length !== 3) {
            console.error(`[vision] the model answers in a shape this worker cannot read: ${String(output?.dims)}`);
            return null;
        }
        rows = dims[1]!;
        if (dims[2] !== ROW_LENGTH) {
            console.error(`[vision] the model reports ${dims[2]} values a row, and this worker reads ${ROW_LENGTH}`);
            return null;
        }
        if (rows !== candidateCount(size)) {
            console.error(`[vision] the model produced ${rows} rows for a ${size}px square, and ${candidateCount(size)} were expected`);
            return null;
        }
    } catch (error) {
        console.error(`[vision] the model would not run: ${String(error)}`);
        return null;
    }

    const bytes = size * size * 3;
    console.log(`[vision] model ready: ${size}px square, ${rows} candidates a frame`);

    return {
        size,
        async run(frame: Uint8Array): Promise<Float32Array> {
            if (frame.length !== bytes) throw new Error(`frame is ${frame.length} bytes, model takes ${bytes}`);
            // Interleaved blue-green-red to one plane per channel, as floats
            // from 0 to 255. Not divided by anything: this model was trained on
            // raw byte values, and normalizing it here would make every score
            // meaningless without anything failing.
            const planes = new Float32Array(bytes);
            const plane = size * size;
            for (let pixel = 0; pixel < plane; pixel += 1) {
                const source = pixel * 3;
                planes[pixel] = frame[source]!;
                planes[plane + pixel] = frame[source + 1]!;
                planes[plane * 2 + pixel] = frame[source + 2]!;
            }
            const input = new ort.Tensor("float32", planes, [1, 3, size, size]);
            const result = await session.run({ [inputName]: input });
            const output = result[outputName];
            if (!output) throw new Error("the model answered with nothing");
            return output.data as Float32Array;
        },
        async close(): Promise<void> {
            await session.release().catch(() => undefined);
        }
    };
}

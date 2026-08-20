"use client";

/**
 * Running the microphone through a filter before it leaves the browser.
 *
 * The browser's own noise suppression handles a fan and a hiss. It does not
 * handle the cases people actually complain about - a keyboard, a dog, somebody
 * else's conversation in the same room - because it is a signal processor with
 * no idea what a voice is. A model does, and there are free ones small enough to
 * run on every frame of a call:
 *
 * - **GTCRN** (MIT, Rong Xiaobin): a small recurrent network, and the better of
 *   the two by a clear margin on noise that comes and goes.
 * - **RNNoise** (Xiph, BSD): the one Jitsi ships, older and lighter, and the
 *   fallback when the first will not start - a browser without the wasm features
 *   it wants is a browser that should still get something.
 *
 * Both are ordinary AudioWorklets over a wasm binary served from this origin, so
 * nothing about a call reaches anybody else and there is no account, key or
 * quota anywhere in it. The cost is a fraction of one core; the assets are a few
 * hundred kilobytes and are only fetched when somebody turns this on.
 *
 * A processed track is a *different* track: the graph ends at a
 * MediaStreamAudioDestinationNode, and what the call sends is the track that
 * comes out of it. Everything the raw microphone track was for - muting, the
 * device it came from, stopping it at the end - still refers to the raw one, so
 * both are handed back and both have to be let go of.
 *
 * A licensed filter can take the place of the free ones - see `krispModule` -
 * because a paid model is somebody's decision to make and not this file's.
 */

/** Where the staged worklets and models are served from. */
const ASSETS = "/audio";

/**
 * The models, fetched at the moment somebody turns the filter on.
 *
 * Imported here rather than at the top of the file because the package declares
 * `class ... extends AudioWorkletNode` as it loads, and `AudioWorkletNode` is a
 * browser global. A "use client" module is still executed on the server to render
 * the first HTML, so a static import throws there - and it throws for every page
 * that reaches this file through an import chain, whether or not anybody is in a
 * call. That is a 500 on a screen with no microphone on it.
 */
function suppressors() {
    return import("@sapphi-red/web-noise-suppressor");
}

/** The models want 48 kHz, which is what a call runs at anyway. Asked for
 *  explicitly so the graph is never built at a rate the model cannot use. */
import { micGain } from "./mic-gain";

const SAMPLE_RATE = 48_000;

/**
 * How much of the level the filter takes away is put back.
 *
 * A suppressor is not a fader, but it lowers what comes out all the same: it is
 * trained to leave speech and remove everything else, and "everything else"
 * includes the room tone under the speech and the tail of every word. What
 * arrives at the other end is a voice that is cleaner and quieter, and the whole
 * room turning their speakers up is not a fix - it turns up everybody who did
 * not switch the filter on.
 *
 * So the level comes back here, on the way out, where it is one person's
 * microphone rather than everybody's ears. Four decibels: enough to put a
 * filtered voice back beside an unfiltered one, small enough that it is a
 * correction rather than a boost. It is a chosen starting point rather than a
 * measured match - what "the same loudness" is depends on the voice, the room
 * and the model - which is exactly why the limiter below is not optional.
 */
const MAKEUP_GAIN = 1.6;

/**
 * What stops the makeup from clipping.
 *
 * Gain on a signal that was already near full scale does not make it louder, it
 * squares off the peaks - and a squared-off peak is the crackle that sounds
 * worse than the quiet ever did. A limiter just under full scale catches those
 * and leaves everything under them untouched, which on speech is nearly all of
 * it.
 */
const LIMIT_DBFS = -1.5;

/** A microphone with something between it and the call. */
export interface FilteredMic {
    /** What to send. */
    readonly track: MediaStreamTrack;
    /** Let go of the graph. The raw track is the caller's to stop: this only
     *  undoes what it built. */
    readonly stop: () => Promise<void>;
    /** Which filter ended up running, for the line under the setting. Not always
     *  the one asked for: the better model can fail to start. `gain` is the
     *  graph that is only there to make a quiet microphone louder, with no model
     *  in it at all. */
    readonly using: "enhanced" | "light" | "licensed" | "gain";
}

/**
 * What a licensed filter has to be, for Polaris to use it.
 *
 * Deliberately the smallest possible contract, and a Web Audio one rather than
 * any particular vendor's: a module at an address an administrator gave us,
 * exporting a function that returns a node. Polaris connects the microphone to
 * that node and sends whatever comes out.
 *
 * Krisp is the reason it exists. It is not published for anybody to install -
 * every integration of it in the open (LiveKit's, Twilio's) is bound to that
 * vendor's own cloud - so the only honest way to offer it is this: whoever holds
 * the licence hosts the build, and Polaris loads it.
 */
export interface LicensedFilter {
    createNode: (
        context: AudioContext,
        options: { token: string }
    ) => Promise<AudioNode> | AudioNode;
    /** Optional, and called when the call ends. */
    dispose?: () => void;
}

/** How the setting is spelled everywhere it is stored or passed. */
export type MicFilter = "off" | "standard" | "enhanced" | "licensed";

/**
 * Build the graph, or answer null.
 *
 * Null is not an error worth showing: it means there is nothing to do to this
 * microphone, or that this browser could not start a filter - and a call with
 * the browser's own suppression is what happens next either way. Saying so in a
 * dialog would be a warning about a feature nobody switched on.
 *
 * Two things put a graph between the microphone and what leaves: a model, and a
 * level. The level is here rather than in a second graph of its own because a
 * microphone routed through Web Audio twice is two contexts, two buffers and
 * twice the latency for one voice - and because the limiter at the end of this
 * one is exactly what a doubled level needs in front of it.
 */
export async function filterMic(
    track: MediaStreamTrack,
    filter: MicFilter,
    licensed?: { moduleUrl: string; token: string } | null,
    /** How much louder or quieter to make it. One is untouched, and with no
     *  model asked for there is then nothing to build. */
    gain: number = micGain()
): Promise<FilteredMic | null> {
    const model = filter === "enhanced" || filter === "licensed";
    if (!model && gain === 1) return null;
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;

    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    // A context created outside a gesture starts suspended, and a suspended
    // context produces silence - which is worse than no filter at all.
    await context.resume().catch(() => undefined);

    const source = context.createMediaStreamSource(new MediaStream([track]));
    const sink = context.createMediaStreamDestination();

    // No model when the graph is only here to change the level, and a model that
    // will not start is not a reason to throw the level away with it.
    const built = model ? await buildNode(context, filter, licensed) : null;
    if (model && !built) {
        source.disconnect();
        await context.close().catch(() => undefined);
        if (gain === 1) return null;
    }

    // The model, then the level it cost and the level somebody asked for, then
    // the guard on both. Multiplied rather than added: they are two reasons for
    // the same knob, and a doubled voice on top of the model's makeup is what
    // the limiter below is for.
    const makeup = context.createGain();
    makeup.gain.value = (built ? MAKEUP_GAIN : 1) * gain;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_DBFS;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    if (built) {
        source.connect(built.node);
        built.node.connect(makeup);
    } else {
        source.connect(makeup);
    }
    makeup.connect(limiter);
    limiter.connect(sink);

    const out = sink.stream.getAudioTracks()[0];
    if (!out) {
        await context.close().catch(() => undefined);
        return null;
    }

    return {
        track: out,
        using: built ? built.using : "gain",
        stop: async () => {
            built?.dispose();
            source.disconnect();
            makeup.disconnect();
            limiter.disconnect();
            out.stop();
            await context.close().catch(() => undefined);
        }
    };
}

/** The node that does the work, with the free model chosen last. */
async function buildNode(
    context: AudioContext,
    filter: MicFilter,
    licensed?: { moduleUrl: string; token: string } | null
): Promise<{ node: AudioNode; dispose: () => void; using: FilteredMic["using"] } | null> {
    if (filter === "licensed") {
        const node = await licensedNode(context, licensed);
        if (node) return node;
        // Falls through to the free model rather than to nothing: a licence that
        // failed to load should not leave somebody worse off than a person who
        // never had one.
    }

    const better = await gtcrnNode(context);
    if (better) return better;
    return await rnnoiseNode(context);
}

async function gtcrnNode(
    context: AudioContext
): Promise<{ node: AudioNode; dispose: () => void; using: FilteredMic["using"] } | null> {
    try {
        const { GtcrnWorkletNode, loadGtcrn } = await suppressors();
        const wasmBinary = await loadGtcrn({ url: `${ASSETS}/gtcrn.wasm` });
        await context.audioWorklet.addModule(`${ASSETS}/gtcrn-worklet.js`);
        const node = new GtcrnWorkletNode(context, { maxChannels: 1, wasmBinary });
        return { node, dispose: () => node.destroy(), using: "enhanced" };
    } catch {
        return null;
    }
}

async function rnnoiseNode(
    context: AudioContext
): Promise<{ node: AudioNode; dispose: () => void; using: FilteredMic["using"] } | null> {
    try {
        const { RnnoiseWorkletNode, loadRnnoise } = await suppressors();
        const wasmBinary = await loadRnnoise({
            url: `${ASSETS}/rnnoise.wasm`,
            simdUrl: `${ASSETS}/rnnoise_simd.wasm`
        });
        await context.audioWorklet.addModule(`${ASSETS}/rnnoise-worklet.js`);
        const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });
        return { node, dispose: () => node.destroy(), using: "light" };
    } catch {
        return null;
    }
}

/**
 * Load the filter an administrator connected.
 *
 * The address is instance configuration and the module is somebody else's code,
 * so this is as narrow as it can be made: it is imported, one named export is
 * looked for, and anything else about it is ignored. A module that throws, or
 * that is not what it said it was, is a call with the free filter instead.
 */
async function licensedNode(
    context: AudioContext,
    licensed?: { moduleUrl: string; token: string } | null
): Promise<{ node: AudioNode; dispose: () => void; using: FilteredMic["using"] } | null> {
    if (!licensed?.moduleUrl) return null;
    try {
        const module = (await import(/* webpackIgnore: true */ licensed.moduleUrl)) as {
            default?: LicensedFilter;
            filter?: LicensedFilter;
        };
        const found = module.filter ?? module.default;
        if (!found?.createNode) return null;

        const node = await found.createNode(context, { token: licensed.token });
        if (!(node instanceof AudioNode)) return null;
        return { node, dispose: () => found.dispose?.(), using: "licensed" };
    } catch {
        return null;
    }
}

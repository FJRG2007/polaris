"use client";

/**
 * The soundboard's default sounds, made in the browser.
 *
 * Every call has them, so they cannot be somebody's upload, and they must not be
 * anybody else's recording either: Polaris ships no audio file it would have to
 * licence, and none of these imitates one. Each is a few oscillators and a
 * burst of noise rendered once into a buffer by an offline audio context - the
 * same reason `call-sounds` synthesises its tones: nothing to fetch, nothing to
 * 404 after an update, a few hundred bytes of code.
 *
 * Rendered to the same WAV an upload becomes (`encodeWav`), so a default and a
 * space's sound are played by exactly the same path in `soundboard-player`.
 */

import type { DefaultSoundId } from "@/lib/chat/soundboard";
import { encodeWav, SOUND_SAMPLE_RATE } from "@/lib/chat/sound-file";

type Ctx = OfflineAudioContext;

/** A note with a quick attack and an exponential fall, like anything struck. */
function struck(
    ctx: Ctx,
    {
        at,
        seconds,
        from,
        to = from,
        wave = "sine",
        gain = 0.5
    }: {
        at: number;
        seconds: number;
        from: number;
        to?: number;
        wave?: OscillatorType;
        gain?: number;
    }
): void {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + seconds);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
}

/** A held note with a soft start and end, for anything blown. */
function held(
    ctx: Ctx,
    {
        at,
        seconds,
        from,
        to = from,
        wave = "sawtooth",
        gain = 0.25,
        cutoff = 2_400,
        vibrato = 0
    }: {
        at: number;
        seconds: number;
        from: number;
        to?: number;
        wave?: OscillatorType;
        gain?: number;
        cutoff?: number;
        vibrato?: number;
    }
): void {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.linearRampToValueAtTime(to, at + seconds);
    if (vibrato > 0) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.value = vibrato;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(at);
        lfo.stop(at + seconds);
    }
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.linearRampToValueAtTime(gain, at + 0.04);
    amp.gain.setValueAtTime(gain, at + Math.max(0.05, seconds - 0.08));
    amp.gain.linearRampToValueAtTime(0.0001, at + seconds);
    osc.connect(filter).connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
}

/** White noise, made once per render: the stuff of hands, cymbals and air. */
function noiseBuffer(ctx: Ctx, seconds: number): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // A fixed seed rather than Math.random, so a default sounds the same in
    // every browser and on every play.
    let seed = 0x2545f491;
    for (let index = 0; index < data.length; index += 1) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        data[index] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    return buffer;
}

/** A burst of filtered noise. */
function burst(
    ctx: Ctx,
    noise: AudioBuffer,
    {
        at,
        seconds,
        type = "bandpass",
        from,
        to = from,
        q = 1,
        gain = 0.5,
        attack = 0.003
    }: {
        at: number;
        seconds: number;
        type?: BiquadFilterType;
        from: number;
        to?: number;
        q?: number;
        gain?: number;
        attack?: number;
    }
): void {
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    source.buffer = noise;
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, at);
    if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, at + seconds);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start(at, (at * 0.37) % Math.max(0.01, noise.duration - seconds));
    source.stop(at + seconds + 0.02);
}

/** How long each one is, in seconds. All under the 5.2 an upload may be. */
const LENGTH: Record<DefaultSoundId, number> = {
    applause: 2.6,
    rimshot: 1.6,
    crickets: 2.4,
    letdown: 2.6,
    fanfare: 1.8,
    boing: 1.1,
    whoosh: 1.0,
    horn: 1.6
};

/** What each one is made of. */
const MAKE: Record<DefaultSoundId, (ctx: Ctx, noise: AudioBuffer) => void> = {
    // A room's worth of hands: short bursts of band-passed noise at uneven
    // moments, thick in the middle and thinning out at the end.
    applause: (ctx, noise) => {
        let seed = 7;
        const next = () => {
            seed = (seed * 16_807) % 2_147_483_647;
            return seed / 2_147_483_647;
        };
        for (let at = 0.02; at < 2.4; at += 0.012 + next() * 0.03) {
            const fade = at < 0.4 ? at / 0.4 : at > 1.6 ? Math.max(0.05, (2.4 - at) / 0.8) : 1;
            burst(ctx, noise, {
                at,
                seconds: 0.05 + next() * 0.04,
                from: 900 + next() * 2_200,
                q: 1.4,
                gain: 0.22 * fade * (0.5 + next() * 0.5)
            });
        }
    },
    // Two drum hits and a cymbal.
    rimshot: (ctx, noise) => {
        struck(ctx, { at: 0, seconds: 0.22, from: 210, to: 110, gain: 0.7 });
        struck(ctx, { at: 0.24, seconds: 0.22, from: 160, to: 80, gain: 0.7 });
        burst(ctx, noise, { at: 0.24, seconds: 0.08, from: 1_800, q: 3, gain: 0.35 });
        burst(ctx, noise, {
            at: 0.52,
            seconds: 1.0,
            type: "highpass",
            from: 6_500,
            gain: 0.32,
            attack: 0.002
        });
    },
    // Three crickets taking turns: fast chirps of a high tone, in groups.
    crickets: (ctx) => {
        const callers = [
            { start: 0.05, pitch: 4_700 },
            { start: 0.55, pitch: 5_100 },
            { start: 1.25, pitch: 4_900 }
        ];
        for (const { start, pitch } of callers) {
            for (let group = 0; group < 2; group += 1) {
                for (let chirp = 0; chirp < 4; chirp += 1) {
                    struck(ctx, {
                        at: start + group * 0.45 + chirp * 0.035,
                        seconds: 0.03,
                        from: pitch,
                        gain: 0.12
                    });
                }
            }
        }
    },
    // A brass figure that gives up: three falling notes and a long one that
    // sags and wobbles.
    letdown: (ctx) => {
        const notes = [392, 370, 349];
        notes.forEach((pitch, index) => {
            held(ctx, { at: index * 0.42, seconds: 0.4, from: pitch, gain: 0.22, cutoff: 1_600 });
        });
        held(ctx, {
            at: 1.28,
            seconds: 1.25,
            from: 330,
            to: 300,
            gain: 0.24,
            cutoff: 1_400,
            vibrato: 9
        });
    },
    // Three rising notes and a chord.
    fanfare: (ctx) => {
        const rise = [523.25, 659.25, 783.99];
        rise.forEach((pitch, index) => {
            held(ctx, {
                at: index * 0.13,
                seconds: 0.14,
                from: pitch,
                wave: "square",
                gain: 0.1,
                cutoff: 3_000
            });
        });
        for (const pitch of [523.25, 659.25, 783.99, 1_046.5]) {
            held(ctx, {
                at: 0.42,
                seconds: 1.3,
                from: pitch,
                wave: "square",
                gain: 0.07,
                cutoff: 2_600
            });
        }
    },
    // A spring: a tone that drops and comes back up, wobbling as it settles.
    boing: (ctx) => {
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(160, 0);
        osc.frequency.exponentialRampToValueAtTime(520, 0.12);
        osc.frequency.exponentialRampToValueAtTime(300, 1.0);
        lfo.frequency.setValueAtTime(18, 0);
        lfo.frequency.linearRampToValueAtTime(7, 1.0);
        depth.gain.setValueAtTime(90, 0);
        depth.gain.linearRampToValueAtTime(10, 1.0);
        lfo.connect(depth).connect(osc.frequency);
        amp.gain.setValueAtTime(0.0001, 0);
        amp.gain.exponentialRampToValueAtTime(0.55, 0.01);
        amp.gain.exponentialRampToValueAtTime(0.0001, 1.05);
        osc.connect(amp).connect(ctx.destination);
        osc.start(0);
        lfo.start(0);
        osc.stop(1.08);
        lfo.stop(1.08);
    },
    // Something passing close: noise swept up and back through a band.
    whoosh: (ctx, noise) => {
        burst(ctx, noise, {
            at: 0,
            seconds: 0.95,
            from: 300,
            to: 3_800,
            q: 2.2,
            gain: 0.6,
            attack: 0.4
        });
    },
    // A ship's horn: two low notes a fifth apart, together, with a slow swell.
    horn: (ctx) => {
        for (const pitch of [146.83, 220]) {
            held(ctx, { at: 0, seconds: 1.5, from: pitch, gain: 0.2, cutoff: 1_100 });
        }
        held(ctx, { at: 0, seconds: 1.5, from: 73.42, wave: "triangle", gain: 0.25, cutoff: 600 });
    }
};

/** Each one, once rendered, for the rest of the tab's life. */
const rendered = new Map<DefaultSoundId, Promise<Uint8Array>>();

/**
 * One default sound as a WAV file.
 *
 * Normalised to the same peak, so the eight are about as loud as each other and
 * the volume a listener chose means the same thing for all of them.
 */
export function defaultSoundFile(id: DefaultSoundId): Promise<Uint8Array> {
    const cached = rendered.get(id);
    if (cached) return cached;
    const made = (async () => {
        const seconds = LENGTH[id];
        const ctx = new OfflineAudioContext(
            1,
            Math.ceil(seconds * SOUND_SAMPLE_RATE),
            SOUND_SAMPLE_RATE
        );
        MAKE[id](ctx, noiseBuffer(ctx, Math.min(3, seconds + 0.5)));
        const buffer = await ctx.startRendering();
        const samples = buffer.getChannelData(0);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        if (peak > 0) {
            const scale = 0.8 / peak;
            for (let index = 0; index < samples.length; index += 1) {
                samples[index] = (samples[index] ?? 0) * scale;
            }
        }
        return encodeWav(samples);
    })();
    made.catch(() => rendered.delete(id));
    rendered.set(id, made);
    return made;
}

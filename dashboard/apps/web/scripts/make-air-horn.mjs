/**
 * Writes the soundboard's built-in "horn": an air horn, made here from nothing.
 *
 * The recording it replaces was a cruise ship's foghorn, which nobody reaching
 * for a horn on a soundboard means. This one is synthesized - three detuned,
 * band-limited sawtooth voices in a minor chord, blown short, short, long - so
 * it is Polaris's own work, released under CC0 like every other built-in sound,
 * and can be made again byte for byte:
 *
 *     node scripts/make-air-horn.mjs
 *
 * Written the way `public/sounds/soundboard/sources.json` says every built-in
 * sound is: mono, 22.05 kHz, 16-bit PCM, faded in and out, gated RMS at -20
 * dBFS with peaks under -1 dBFS.
 */

import { writeFileSync } from "node:fs";

const RATE = 22_050;
const NYQUIST = RATE / 2;
/** Short, short, long - seconds on and the gap after each. */
const BLASTS = [
    [0.16, 0.07],
    [0.16, 0.07],
    [0.95, 0]
];
/** A minor chord around A3, each voice a little off the others, which is what
 *  makes it a horn rather than an organ. */
const VOICES = [220, 261.6, 329.6].flatMap((hz) => [hz * 0.997, hz * 1.004]);
const LEAD = 0.02;
const TAIL = 0.12;

const total = Math.ceil((LEAD + BLASTS.reduce((sum, [on, gap]) => sum + on + gap, 0) + TAIL) * RATE);
const samples = new Float64Array(total);

/** One band-limited sawtooth: harmonics at 1/n, none above Nyquist, so it
 *  carries no aliasing whistle. */
function saw(hz, time) {
    let value = 0;
    for (let n = 1; hz * n < NYQUIST * 0.9; n += 1) value += Math.sin(2 * Math.PI * hz * n * time) / n;
    return value;
}

let at = Math.round(LEAD * RATE);
for (const [on, gap] of BLASTS) {
    const length = Math.round(on * RATE);
    const attack = 0.012 * RATE;
    const release = 0.04 * RATE;
    for (let index = 0; index < length; index += 1) {
        const time = index / RATE;
        // A horn starts a touch flat and settles as the pressure builds.
        const bend = 1 - 0.03 * Math.exp(-time / 0.03);
        let value = 0;
        for (const hz of VOICES) value += saw(hz * bend, time);
        const envelope = Math.min(1, index / attack, (length - index) / release);
        samples[at + index] += value * envelope;
    }
    at += length + Math.round(gap * RATE);
}

// A little saturation, the way a real one overdrives its own reed.
for (let index = 0; index < total; index += 1) samples[index] = Math.tanh(samples[index] * 0.6);

/** RMS over 50 ms blocks, ignoring blocks 30 dB under the loudest. */
function gatedRms(data) {
    const block = Math.floor(RATE / 20);
    const levels = [];
    for (let start = 0; start + block <= data.length; start += block) {
        let sum = 0;
        for (let index = start; index < start + block; index += 1) sum += data[index] ** 2;
        levels.push(sum / block);
    }
    const loudest = Math.max(...levels);
    const kept = levels.filter((level) => level > loudest * 1e-3);
    return Math.sqrt(kept.reduce((sum, level) => sum + level, 0) / kept.length);
}

const gain = 10 ** (-20 / 20) / gatedRms(samples);
let peak = 0;
for (let index = 0; index < total; index += 1) peak = Math.max(peak, Math.abs(samples[index] * gain));
if (peak > 10 ** (-1 / 20)) throw new Error(`peak ${peak.toFixed(3)} is over -1 dBFS`);

const wav = Buffer.alloc(44 + total * 2);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(36 + total * 2, 4);
wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(total * 2, 40);
for (let index = 0; index < total; index += 1) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index] * gain)) * 32_767), 44 + index * 2);
}

writeFileSync(new URL("../public/sounds/soundboard/horn.wav", import.meta.url), wav);

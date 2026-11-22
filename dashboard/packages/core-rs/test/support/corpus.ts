/**
 * The inputs each golden-vector file is generated from (plan 4.1): real-shaped,
 * edge, empty, huge, unicode and malformed. Arguments are written in the vector
 * format, so tags like `$utf16` and `$repeat` survive into the files as written.
 */

import * as probe from "../../src/domains/probe/ts";

export interface CorpusEntry {
    domain: string;
    op: string;
    source: string;
    fn: (...args: never[]) => unknown;
    cases: { name: string; args: unknown[] }[];
}

const PROBE_SOURCE = "dashboard/packages/core-rs/src/domains/probe/ts.ts";
const utf16 = (...units: number[]) => ({ $utf16: units });
const repeat = (text: string, times: number) => ({ $repeat: { text, times } });

let allBytes = "";
for (let i = 0; i < 256; i++) allBytes += i.toString(16).padStart(2, "0");
let printable = "";
for (let i = 0x20; i < 0x7f; i++) printable += String.fromCharCode(i);

export const CORPUS: CorpusEntry[] = [
    {
        domain: "probe",
        op: "fnv1a32",
        source: PROBE_SOURCE,
        fn: probe.fnv1a32 as CorpusEntry["fn"],
        cases: [
            { name: "empty", args: [""] },
            { name: "one letter", args: ["a"] },
            { name: "standard vector foobar", args: ["foobar"] },
            { name: "real-shaped e-mail", args: ["someone@example.com"] },
            { name: "printable ASCII", args: [printable] },
            { name: "NUL", args: ["\u0000"] },
            { name: "two-byte UTF-8", args: ["é"] },
            { name: "combining accent", args: ["é"] },
            { name: "CJK", args: ["日本語"] },
            { name: "astral emoji", args: ["😀"] },
            { name: "ZWJ family", args: ["👩‍👩‍👧‍👦"] },
            { name: "BOM", args: ["﻿"] },
            { name: "U+FFFF", args: ["￿"] },
            { name: "lone high surrogate", args: [utf16(0xd800)] },
            { name: "lone low surrogate", args: [utf16(0xdc00)] },
            { name: "surrogates reversed", args: [utf16(0xdc00, 0xd800)] },
            { name: "lone surrogate between letters", args: [utf16(0x61, 0xdbff, 0x62)] },
            { name: "U+FFFD itself", args: ["�"] },
            { name: "huge (1 MiB)", args: [repeat("Polaris ", 131072)] },
            { name: "huge emoji run", args: [repeat("👩‍👩‍👧‍👦", 4000)] }
        ]
    },
    {
        domain: "probe",
        op: "decodeHex",
        source: PROBE_SOURCE,
        fn: probe.decodeHex as CorpusEntry["fn"],
        cases: [
            { name: "empty", args: [""] },
            { name: "zero byte", args: ["00"] },
            { name: "lowercase ff", args: ["ff"] },
            { name: "uppercase FF", args: ["FF"] },
            { name: "mixed case", args: ["00ffAb10"] },
            { name: "every digit", args: ["0123456789abcdefABCDEF"] },
            { name: "all 256 bytes", args: [allBytes] },
            { name: "real-shaped digest", args: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"] },
            { name: "NUL characters", args: ["\u0000\u0000"] },
            { name: "odd length 1", args: ["0"] },
            { name: "odd length 3", args: ["abc"] },
            { name: "odd length wins over bad characters", args: ["zzz"] },
            { name: "bad first character", args: ["g0"] },
            { name: "bad second character", args: ["0g"] },
            { name: "0x prefix", args: ["0x00"] },
            { name: "leading space", args: [" 0"] },
            { name: "inner space", args: ["00 0"] },
            { name: "two-byte UTF-8 character", args: ["é0"] },
            { name: "astral character counts two units", args: ["00😀"] },
            { name: "Arabic-Indic digits", args: ["٠١"] },
            { name: "fullwidth digits", args: ["０１"] },
            { name: "lone surrogate second", args: [utf16(0x30, 0xd800)] },
            { name: "lone surrogate first", args: [utf16(0xdc00, 0x30)] },
            { name: "huge valid (64 KiB)", args: [repeat("0f", 32768)] },
            { name: "huge mixed case", args: [repeat("aB", 4096)] }
        ]
    }
];

/**
 * Which Firefox Translations models the local engine uses, and where they come
 * from. Pure: shared by the screen, the worker engine and the route that serves
 * the files.
 *
 * The models are Mozilla's int8 Marian students (github.com/mozilla/translations),
 * one per direction between English and another language. A pair without
 * English goes through English: two models, which Bergamot chains itself.
 * Polaris downloads each file once from a mirror pinned to one revision
 * (huggingface.co/midudev/firefox-translations, byte-for-byte Mozilla's files)
 * and serves it from its own storage, so a reader never asks a third party.
 */

import { z } from "zod";
import { LOCAL_MODEL_FILES, LOCAL_MODEL_REVISION } from "./local-registry";

export type LocalModelRole = "model" | "lex" | "vocab" | "srcvocab" | "trgvocab";

export interface LocalModelFile {
    readonly role: LocalModelRole;
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
}

/** The mirror every file is downloaded from, pinned to one revision. */
export const LOCAL_MODEL_ORIGIN = "https://huggingface.co";
const MIRROR_REPOSITORY = "midudev/firefox-translations";

/** Where the screen asks Polaris for a model file. */
export const LOCAL_MODEL_API = "/api/translate/models";

/** Where the Bergamot runtime is staged at build time (scripts/copy-bergamot-assets.mjs). */
export const LOCAL_RUNTIME_WORKER = "/bergamot/translator-worker.js";

/** Every pair Polaris serves, as the mirror names it (`en-es`, `zh-Hant-en`). */
export const LOCAL_PAIRS = Object.keys(LOCAL_MODEL_FILES);

/** One of our codes as the mirror spells it: Simplified Chinese is plain `zh`. */
export function mirrorCode(code: string): string {
    if (code === "zh-Hans") return "zh";
    if (code === "pt-BR") return "pt";
    return code;
}

/** A mirror pair's name: `en-es`. */
export function pairName(from: string, to: string): string {
    return `${mirrorCode(from)}-${mirrorCode(to)}`;
}

/**
 * The models that take `from` into `to`, in the order they run, or null when
 * the local engine cannot do it. Through English when neither side is English.
 */
export function modelsFor(from: string, to: string): { from: string; to: string }[] | null {
    const source = mirrorCode(from);
    const target = mirrorCode(to);
    if (source === target) return [];
    const steps =
        source === "en" || target === "en"
            ? [{ from: source, to: target }]
            : [
                  { from: source, to: "en" },
                  { from: "en", to: target }
              ];
    return steps.every((step) => LOCAL_MODEL_FILES[`${step.from}-${step.to}`]) ? steps : null;
}

/** The files of one mirror pair, or an empty list when it is not one Polaris serves. */
export function pairFiles(pair: string): readonly LocalModelFile[] {
    return Object.hasOwn(LOCAL_MODEL_FILES, pair) ? LOCAL_MODEL_FILES[pair]! : [];
}

/** How many bytes a translation from `from` into `to` downloads the first time. */
export function downloadSize(from: string, to: string): number {
    return (modelsFor(from, to) ?? [])
        .flatMap((step) => pairFiles(`${step.from}-${step.to}`))
        .reduce((sum, file) => sum + file.size, 0);
}

/** The address of one file at the pinned revision, upstream. */
export function upstreamUrl(pair: string, file: LocalModelFile): string {
    return `${LOCAL_MODEL_ORIGIN}/${MIRROR_REPOSITORY}/resolve/${LOCAL_MODEL_REVISION}/${pair}/${file.name}`;
}

/** The address the screen fetches one file from: Polaris, never the mirror. */
export function servedUrl(pair: string, file: LocalModelFile): string {
    return `${LOCAL_MODEL_API}/${pair}/${file.name}?rev=${LOCAL_MODEL_REVISION.slice(0, 12)}`;
}

/**
 * The route's parameters: a pair from the pinned list and one of that pair's
 * files, nothing else - no path a caller makes up reaches the disk or the mirror.
 */
export const modelFileParams = z
    .object({
        pair: z.string().refine((pair) => pairFiles(pair).length > 0, { message: "pair" }),
        file: z.string().max(80)
    })
    .strict()
    .transform((params, context) => {
        const file = pairFiles(params.pair).find((entry) => entry.name === params.file);
        if (!file) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "file", path: ["file"] });
            return z.NEVER;
        }
        return { pair: params.pair, file };
    });

export type ModelFileParams = z.infer<typeof modelFileParams>;

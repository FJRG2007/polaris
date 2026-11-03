/**
 * What the Translate app reads that is not text, on this server: the words in
 * a picture (Polar's model, one that reads images) and the words in a
 * recording (the transcription model Polar dictates with). Both go through the
 * keys and limits Polar already has, so whatever answers Polar answers here
 * and nothing new has to be set up.
 *
 * The bytes are held in memory only for the call to the provider and never
 * stored.
 *
 * Server-only.
 */

import { z } from "zod";
import { PLAIN_TURN } from "@/lib/polar/automatic";
import { automaticChoice } from "@/lib/polar/shared";
import { resolvePolarModel } from "@/lib/polar/models";
import { EngineRefusal } from "@/lib/translate/server-engines";
import { experimental_transcribe as transcribe, generateText } from "ai";
import { polarTranscriber, polarVoiceAvailability } from "@/lib/polar/voice";
import { answerUsage, polarLimitReached, recordPolarUsage } from "@/lib/polar/usage";
import { classifyProviderFailure, failureLogLine } from "@/lib/polar/provider-failure";
import { helperMaySpend, helperReasoning, type PolarHelper } from "@/lib/polar/helper-model";

/** A turn carrying one file: the automatic pick keeps a model that reads it. */
const IMAGE_TURN = { ...PLAIN_TURN, files: 1 };

async function imageReader(userId: string): Promise<PolarHelper | null> {
    const resolved = await resolvePolarModel(userId, automaticChoice("fast"), IMAGE_TURN);
    return typeof resolved === "string" ? null : { resolved, source: "automatic" };
}

export interface MediaStatus {
    /** A model that reads pictures can answer this person. */
    images: boolean;
    /** A transcription model can answer this person. */
    audio: boolean;
}

/** What this person can have read here. Sends nothing. */
export async function serverMediaStatus(userId: string): Promise<MediaStatus> {
    const [images, audio] = await Promise.all([
        imageReader(userId).then(
            (reader) => reader !== null,
            () => false
        ),
        polarVoiceAvailability(userId).then(
            (voice) => voice.dictation,
            () => false
        )
    ]);
    return { images, audio };
}

/** One line of text in a picture; `box` is `[x, y, width, height]`, 0 to 1. */
export interface ImageLine {
    text: string;
    box: [number, number, number, number] | null;
}

const READ_PROMPT = [
    "Read every line of text in this image, top to bottom, in reading order.",
    'Reply with only JSON of the shape {"lines": [{"text": string, "box": [x, y, width, height]}]},',
    "where the box is the line's position as fractions of the image's width and height (0 to 1).",
    'Copy the text exactly as written; never translate or explain. No text at all: {"lines": []}.'
].join(" ");

const unit = z.number().min(0).max(1);
const readAnswer = z.object({
    lines: z
        .array(
            z.object({
                text: z.string().max(2000),
                box: z.tuple([unit, unit, unit, unit]).nullish()
            })
        )
        .max(500)
});

/** The model's reply as JSON, from inside a code fence if it wrote one. */
function jsonIn(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/** The lines of text in an image. Throws `EngineRefusal` for what the reader is told. */
export async function serverReadImage(
    userId: string,
    image: Uint8Array,
    mediaType: string
): Promise<{ lines: ImageLine[] }> {
    const helper = await imageReader(userId);
    if (!helper) throw new EngineRefusal("unavailable");
    if (!(await helperMaySpend(userId, helper))) throw new EngineRefusal("limit");
    const { option, credential } = helper.resolved;
    let text: string;
    try {
        const answer = await generateText({
            model: helper.resolved.model,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: READ_PROMPT },
                        { type: "image", image, mediaType }
                    ]
                }
            ],
            maxOutputTokens: 8000,
            reasoning: helperReasoning(helper),
            abortSignal: AbortSignal.timeout(90_000)
        });
        text = answer.text;
        await recordPolarUsage({
            userId,
            threadId: null,
            messageId: null,
            provider: option.provider,
            model: option.model,
            payer: credential.source === "instance" ? "instance" : "own",
            usage: answerUsage(answer.totalUsage, option)
        }).catch((error: unknown) => console.error("translate: could not record usage", error));
    } catch (error) {
        console.warn(
            failureLogLine("reading an image", option.providerName, classifyProviderFailure(error))
        );
        throw new EngineRefusal("failed");
    }
    const parsed = readAnswer.safeParse(jsonIn(text));
    if (!parsed.success) throw new EngineRefusal("failed");
    return {
        lines: parsed.data.lines
            .filter((line) => line.text.trim())
            .map((line) => ({ text: line.text, box: line.box ?? null }))
    };
}

/** What was said in a recording. Throws `EngineRefusal` for what the reader is told. */
export async function serverTranscribe(
    userId: string,
    audio: Uint8Array,
    durationMs: number
): Promise<{ text: string }> {
    const transcriber = await polarTranscriber(userId);
    if (!transcriber) throw new EngineRefusal("unavailable");
    if (transcriber.source === "instance" && (await polarLimitReached(userId))) {
        throw new EngineRefusal("limit");
    }
    try {
        const result = await transcribe({
            model: transcriber.model,
            audio,
            abortSignal: AbortSignal.timeout(120_000)
        });
        const seconds =
            typeof result.durationInSeconds === "number" &&
            Number.isFinite(result.durationInSeconds)
                ? result.durationInSeconds
                : durationMs / 1000;
        await recordPolarUsage({
            userId,
            threadId: null,
            messageId: null,
            provider: transcriber.option.provider,
            model: transcriber.option.model,
            payer: transcriber.source,
            usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
            audioSeconds: Math.ceil(seconds)
        }).catch((error: unknown) => console.error("translate: could not record usage", error));
        return { text: result.text.trim() };
    } catch (error) {
        console.error("translate: transcription failed", error);
        throw new EngineRefusal("failed");
    }
}

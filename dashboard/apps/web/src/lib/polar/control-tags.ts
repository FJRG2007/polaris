/**
 * Control markup some models write into their answer's text instead of their
 * provider's reasoning field: `<think>...</think>`, an answer wrapped in
 * `<final_answer>`, chat-template tokens such as `<|channel|>analysis<|message|>`,
 * and the bare `analysis...assistantfinal` that is left of the gpt-oss harmony
 * format once a server strips its special tokens. None of it is meant to be
 * read: thinking goes where Polar shows its thinking, wrappers and tokens are
 * dropped, and what is left is the answer.
 *
 * The scanner is the same idea as the AI SDK's `extractReasoningMiddleware`
 * (`ai/src/middleware/extract-reasoning-middleware.ts`), which holds back a
 * tag split across chunks (`getPotentialStartIndex`) and turns one tag into
 * reasoning parts. This one knows every tag above at once, and only acts at the
 * answer's own level: inside a fenced or inline code span every character is
 * the answer's, so a code sample that shows `<final_answer>` keeps it. Open
 * WebUI and LibreChat split `<think>` the same way, at the start of a line.
 *
 * Unknown tags are left alone. Pure and safe in the browser.
 */

import type { LanguageModelMiddleware } from "ai";

export interface ControlSegment {
    kind: "text" | "reasoning";
    text: string;
}

/** Tags whose content is the model's thinking. */
const REASONING_TAGS: ReadonlySet<string> = new Set(["think", "thinking", "reasoning", "analysis", "thought"]);
/** Tags that only wrap the answer: dropped, their content kept. */
const WRAPPER_TAGS: ReadonlySet<string> = new Set(["final_answer", "final", "answer"]);

const TAG = /<(\/?)([a-z_]+)[ \t]*>/iy;
const TAG_PARTIAL = /^<\/?(?:[a-z_]+[ \t]*)?$/i;
const TOKEN = /<\|([a-z_]+)\|>/iy;
const TOKEN_PARTIAL = /^<(?:\|[a-z_]*\|?)?$/i;
const CHANNEL = /<\|channel\|>([^<\n]{0,60})<\|message\|>/iy;
const CHANNEL_PARTIAL = /^<\|channel\|>[^<\n]{0,60}(?:<[|a-z]*)?$/i;
const ROLE = /<\|(?:im_)?start\|>[a-z]*\n?/iy;
/** Harmony's final-channel marker once its tokens are stripped. */
const FINAL_MARK = "assistantfinal";
/** Harmony's analysis channel at the very start, tokens stripped:
 *  `analysisThe user asks...`. */
const ANALYSIS_START = "analysis";
/** Longest tail held back while it could still become a tag. */
const HOLD_MOST = 40;

/** Whether `rest` could still grow into `whole`. */
function couldBecome(rest: string, whole: string): boolean {
    return rest.length < whole.length && whole.startsWith(rest);
}

/**
 * A streaming scanner: `push` each delta, `end` when the text ends. Each call
 * returns what can be shown now; a tail that may still turn out to be a tag
 * is held until the next delta decides it.
 */
export class ControlTagScanner {
    private buffer = "";
    private mode: "text" | "reasoning" = "text";
    /** What ends the thinking: a tag name, the harmony tokens, or the stripped
     *  final marker. */
    private close: string | null = null;
    /** The backtick or tilde run of the open fence. */
    private fence: string | null = null;
    /** The backtick run of the open inline code span; 0 outside one. */
    private inline = 0;
    /** Only spaces and tabs so far on this line. */
    private blankLine = true;
    /** Anything but whitespace seen yet. */
    private seen = false;
    /** Whitespace not yet shown: kept when more of the same kind follows,
     *  dropped at a change of kind or the end. */
    private space = "";
    /** Whether this run of one kind has shown anything; its leading
     *  whitespace is dropped until it has. */
    private started = false;
    private out: ControlSegment[] = [];
    /** Whether any markup was taken out. */
    changed = false;

    push(delta: string): ControlSegment[] {
        this.buffer += delta;
        this.scan(false);
        return this.take();
    }

    end(): ControlSegment[] {
        this.scan(true);
        this.space = "";
        return this.take();
    }

    private take(): ControlSegment[] {
        const out = this.out;
        this.out = [];
        return out;
    }

    private emit(kind: ControlSegment["kind"], text: string): void {
        if (!text) return;
        const core = text.trim();
        if (!core) {
            if (this.started) this.space += text;
            return;
        }
        const lead = this.started ? this.space + text.slice(0, text.length - text.trimStart().length) : "";
        this.space = text.slice(text.trimEnd().length);
        this.started = true;
        this.seen = true;
        const last = this.out.at(-1);
        if (last?.kind === kind) last.text += lead + core;
        else this.out.push({ kind, text: lead + core });
    }

    private switchTo(mode: "text" | "reasoning", close: string | null): void {
        this.mode = mode;
        this.close = close;
        this.changed = true;
        this.seen = true;
        this.inline = 0;
        this.space = "";
        this.started = false;
    }

    /** A `<|...|>` token at `at`: its length taken, or -1 to wait, or 0 when
     *  there is none. */
    private token(b: string, at: number, final: boolean): number {
        CHANNEL.lastIndex = at;
        const channel = CHANNEL.exec(b);
        if (channel) {
            const name = channel[1]!.trim().toLowerCase();
            if (name.startsWith("analysis") || name.startsWith("commentary")) this.switchTo("reasoning", "harmony");
            else this.switchTo("text", null);
            return channel[0].length;
        }
        const rest = b.slice(at, at + HOLD_MOST * 2);
        if (!final && CHANNEL_PARTIAL.test(rest)) return -1;
        ROLE.lastIndex = at;
        const role = ROLE.exec(b);
        if (role) {
            if (!final && at + role[0].length === b.length) return -1;
            this.changed = true;
            return role[0].length;
        }
        TOKEN.lastIndex = at;
        const token = TOKEN.exec(b);
        if (token) {
            const name = token[1]!.toLowerCase();
            if (this.close === "harmony" && (name === "end" || name === "return" || name === "call")) {
                this.switchTo("text", null);
            }
            this.changed = true;
            return token[0].length;
        }
        if (!final && TOKEN_PARTIAL.test(b.slice(at, at + HOLD_MOST))) return -1;
        return 0;
    }

    private scan(final: boolean): void {
        const b = this.buffer;
        let i = 0;
        let plain = "";
        const flush = () => {
            this.emit(this.mode, plain);
            plain = "";
        };
        const hold = () => {
            flush();
            this.buffer = b.slice(i);
        };
        while (i < b.length) {
            const c = b[i]!;
            // The harmony analysis channel with its tokens stripped, at the start.
            if (!this.seen && this.mode === "text" && !this.fence && c === "a" && !/\S/.test(plain)) {
                const rest = b.slice(i, i + ANALYSIS_START.length + 1);
                if (!final && rest.length <= ANALYSIS_START.length && ANALYSIS_START.startsWith(rest)) return hold();
                if (rest.startsWith(ANALYSIS_START) && /^[A-Z\n]$/.test(rest.slice(ANALYSIS_START.length))) {
                    plain = "";
                    this.switchTo("reasoning", FINAL_MARK);
                    i += ANALYSIS_START.length;
                    continue;
                }
            }
            if (this.mode === "reasoning") {
                if (c === "<" && this.close !== FINAL_MARK) {
                    if (this.close === "harmony") {
                        flush();
                        const taken = this.token(b, i, final);
                        if (taken < 0) return hold();
                        if (taken > 0) {
                            i += taken;
                            continue;
                        }
                    } else {
                        TAG.lastIndex = i;
                        const tag = TAG.exec(b);
                        if (tag && tag[1] === "/" && tag[2]!.toLowerCase() === this.close) {
                            flush();
                            this.switchTo("text", null);
                            i += tag[0].length;
                            continue;
                        }
                        if (!tag && !final && TAG_PARTIAL.test(b.slice(i, i + HOLD_MOST))) return hold();
                    }
                }
                if (c === "a" && this.close === FINAL_MARK) {
                    if (b.startsWith(FINAL_MARK, i)) {
                        flush();
                        this.switchTo("text", null);
                        i += FINAL_MARK.length;
                        continue;
                    }
                    if (!final && couldBecome(b.slice(i), FINAL_MARK)) return hold();
                }
                plain += c;
                i += 1;
                continue;
            }
            if (c === "\n") {
                plain += c;
                i += 1;
                this.blankLine = true;
                this.inline = 0;
                continue;
            }
            if (c === "`" || c === "~") {
                let run = 1;
                while (b[i + run] === c) run += 1;
                if (!final && i + run === b.length) return hold();
                const fenceRun = c.repeat(run);
                if (this.fence) {
                    if (this.blankLine && c === this.fence[0] && run >= this.fence.length) this.fence = null;
                } else if (this.blankLine && run >= 3) {
                    this.fence = fenceRun;
                } else if (c === "`") {
                    if (this.inline === 0) this.inline = run;
                    else if (this.inline === run) this.inline = 0;
                }
                plain += fenceRun;
                i += run;
                this.blankLine = false;
                continue;
            }
            const code = this.fence !== null || this.inline > 0;
            if (c === "<" && !code) {
                flush();
                const taken = this.token(b, i, final);
                if (taken < 0) return hold();
                if (taken > 0) {
                    i += taken;
                    continue;
                }
                TAG.lastIndex = i;
                const tag = TAG.exec(b);
                if (tag) {
                    const name = tag[2]!.toLowerCase();
                    const closing = tag[1] === "/";
                    if (WRAPPER_TAGS.has(name) || (closing && REASONING_TAGS.has(name))) {
                        flush();
                        this.changed = true;
                        this.seen = true;
                        i += tag[0].length;
                        continue;
                    }
                    if (REASONING_TAGS.has(name) && this.blankLine) {
                        flush();
                        this.switchTo("reasoning", name);
                        i += tag[0].length;
                        continue;
                    }
                } else if (!final && TAG_PARTIAL.test(b.slice(i, i + HOLD_MOST))) {
                    return hold();
                }
            }
            if (c === "a" && !code) {
                if (b.startsWith(FINAL_MARK, i)) {
                    flush();
                    this.changed = true;
                    i += FINAL_MARK.length;
                    continue;
                }
                if (!final && couldBecome(b.slice(i), FINAL_MARK)) return hold();
            }
            if (c !== " " && c !== "\t") this.blankLine = false;
            plain += c;
            i += 1;
        }
        flush();
        this.buffer = "";
    }
}

/** A whole text split into what it says and what it thought. Pure. */
export function splitControlTags(text: string): { segments: ControlSegment[]; changed: boolean } {
    const scanner = new ControlTagScanner();
    const segments = [...scanner.push(text), ...scanner.end()];
    return { segments, changed: scanner.changed };
}

type StoredPart = { type: string; text?: unknown; [key: string]: unknown };

/**
 * A stored answer's parts with the markup taken out: what an answer saved
 * before the stream was cleaned still shows. A part with none is returned as
 * it was, so an answer without any stays the same array. Pure.
 */
export function withoutControlTags<P>(parts: readonly P[]): P[] {
    let touched = false;
    const out: P[] = [];
    for (const part of parts) {
        const stored = part as unknown as StoredPart;
        if (!stored || stored.type !== "text" || typeof stored.text !== "string" || !/[<a]/.test(stored.text)) {
            out.push(part);
            continue;
        }
        const { segments, changed } = splitControlTags(stored.text);
        if (!changed) {
            out.push(part);
            continue;
        }
        touched = true;
        for (const segment of segments) {
            out.push(
                (segment.kind === "text"
                    ? { ...stored, text: segment.text }
                    : { type: "reasoning", text: segment.text, state: "done" }) as unknown as P
            );
        }
    }
    return touched ? out : (parts as P[]);
}

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type StreamResult = Awaited<ReturnType<Parameters<WrapStream>[0]["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type GenerateResult = Awaited<ReturnType<Parameters<WrapGenerate>[0]["doGenerate"]>>;
type Content = GenerateResult["content"][number];

/** One text block of the stream being cleaned: its scanner and the parts it
 *  has opened. */
interface Block {
    scanner: ControlTagScanner;
    open: { kind: ControlSegment["kind"]; id: string } | null;
    count: number;
    metadata: unknown;
}

/** The stream's text parts with control markup moved to reasoning or taken
 *  out; everything else passes as it came. */
export function cleanControlStream(): TransformStream<StreamPart, StreamPart> {
    const blocks = new Map<string, Block>();
    const write = (
        controller: TransformStreamDefaultController<StreamPart>,
        id: string,
        block: Block,
        segments: ControlSegment[],
        metadata?: unknown
    ) => {
        for (const segment of segments) {
            if (block.open?.kind !== segment.kind) {
                if (block.open) controller.enqueue({ type: `${block.open.kind}-end`, id: block.open.id } as StreamPart);
                // The first text keeps the provider's id; a later one is new.
                const partId = block.count === 0 && segment.kind === "text" ? id : `${id}:${block.count}`;
                block.count += 1;
                block.open = { kind: segment.kind, id: partId };
                controller.enqueue({
                    type: `${segment.kind}-start`,
                    id: partId,
                    ...(block.metadata && segment.kind === "text" ? { providerMetadata: block.metadata } : {})
                } as StreamPart);
            }
            controller.enqueue({
                type: `${segment.kind}-delta`,
                id: block.open.id,
                delta: segment.text,
                ...(metadata && segment.kind === "text" ? { providerMetadata: metadata } : {})
            } as StreamPart);
        }
    };
    return new TransformStream<StreamPart, StreamPart>({
        transform(part, controller) {
            if (part.type === "text-start") {
                blocks.set(part.id, {
                    scanner: new ControlTagScanner(),
                    open: null,
                    count: 0,
                    metadata: part.providerMetadata
                });
                return;
            }
            if (part.type === "text-delta") {
                const block = blocks.get(part.id);
                if (!block) return controller.enqueue(part);
                write(controller, part.id, block, block.scanner.push(part.delta), part.providerMetadata);
                return;
            }
            if (part.type === "text-end") {
                const block = blocks.get(part.id);
                if (!block) return controller.enqueue(part);
                write(controller, part.id, block, block.scanner.end());
                if (block.open) {
                    controller.enqueue(
                        block.open.kind === "text" ? { ...part, id: block.open.id } : ({ type: "reasoning-end", id: block.open.id } as StreamPart)
                    );
                }
                blocks.delete(part.id);
                return;
            }
            controller.enqueue(part);
        },
        flush(controller) {
            // A stream that stopped without ending its text still shows it.
            for (const [id, block] of blocks) {
                write(controller, id, block, block.scanner.end());
                if (block.open) controller.enqueue({ type: `${block.open.kind}-end`, id: block.open.id } as StreamPart);
            }
            blocks.clear();
        }
    });
}

/** A generated answer's text content cleaned the same way. */
function cleanContent(content: readonly Content[]): Content[] {
    const out: Content[] = [];
    for (const part of content) {
        if (part.type !== "text") {
            out.push(part);
            continue;
        }
        const { segments, changed } = splitControlTags(part.text);
        if (!changed) {
            out.push(part);
            continue;
        }
        for (const segment of segments) {
            out.push(
                segment.kind === "text"
                    ? { ...part, text: segment.text }
                    : ({ type: "reasoning", text: segment.text } as Content)
            );
        }
    }
    return out;
}

/** The middleware every Polar model call goes through (`router/plan.ts`). */
export const controlTagsMiddleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        return { ...result, content: cleanContent(result.content) };
    },
    wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return { ...result, stream: result.stream.pipeThrough(cleanControlStream()) };
    }
};

/** A stored message's parts as they are shown: an answer's cleaned
 *  (`withoutControlTags`), anything else as it was. Pure. */
export function shownParts<P>(role: string, parts: readonly P[]): P[] {
    return role === "assistant" ? withoutControlTags(parts) : (parts as P[]);
}

/** Only what a text says: its thinking and markup left out. Pure. */
export function answerText(text: string): string {
    if (!/[<a]/.test(text)) return text;
    const { segments, changed } = splitControlTags(text);
    if (!changed) return text;
    return segments
        .filter((segment) => segment.kind === "text")
        .map((segment) => segment.text)
        .join("");
}

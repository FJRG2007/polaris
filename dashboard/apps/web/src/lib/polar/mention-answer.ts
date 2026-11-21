/**
 * Polar answering because somebody named it - in a Chat conversation or in a
 * task's thread.
 *
 * The answer is the asker's: their Polar access, their models and keys, their
 * limits on the shared key, and the usage is recorded against them exactly as a
 * turn in the Polar panel is. When they cannot use Polar - no access, no
 * provider key reachable, the shared key's limit reached - what comes back is
 * the sentence that says so, with the link that fixes it, so the caller posts
 * that instead of staying silent.
 *
 * Tools only when the caller hands a toolkit (`lib/chat/polar-calls.ts`):
 * reads run as the asker, and a change stops the turn so the caller can offer
 * it for approval instead of running it in front of everybody. Server-only.
 */

import { generateText, stepCountIs } from "ai";
import type { chatWordsFor } from "@/lib/chat/text";
import type { MentionToolkit, PendingCall } from "@/lib/chat/polar-calls";

type Words = Awaited<ReturnType<typeof chatWordsFor>>;

/** The longest answer, in tokens; a reply in a thread is not a report. */
const ANSWER_TOKENS = 2_048;
/** How often the caller is asked to show Polar writing. */
const TYPING_EVERY_MS = 2_500;

export interface MentionTurn {
    readonly userId: string;
    readonly words: Words;
    readonly system: string;
    readonly prompt: string;
    /** Where it is recorded and named in a log line. */
    readonly where: string;
    /** Shown while it writes, repeated until it is done. */
    readonly typing?: () => void;
    /** The question and the names in the prompt, to tell an answer from the
     *  prompt handed back (`echoesPrompt`); the prompt alone otherwise. */
    readonly echo?: { readonly question: string; readonly names: readonly string[] };
    /** The asker's tools, when the place offers them. */
    readonly toolkit?: MentionToolkit | null;
    /** Most steps with tools; one without. */
    readonly steps?: number;
}

/** Models asked at most for one mention when each answers with an echo. */
export const ECHO_TRIES = 3;

/** What Polar says when no model can answer for this person, with the way to fix it. */
export function noProviderText(words: Words, spendsShared: boolean): string {
    return [
        words(spendsShared ? "polar.noProvider" : "polar.noProviderOwnOnly"),
        `[${words("polar.addKey")}](/polar/settings/providers)`
    ].join(" ");
}

/** Why there is no answer, for a caller that offers the way out under it.
 *  `providersRefused`: every model the turn could use refused for a reason
 *  asking again does not change - no credit, a key refused, a model gone. */
export type MentionProblem =
    | "notAvailable"
    | "tooFast"
    | "noProvider"
    | "limitReached"
    | "providersRefused"
    | "failed";

/** The refusals that are the person's set-up rather than a bad moment. */
const SETTLED_KINDS = ["credit", "paid", "key", "model"] as const;
type SettledKind = (typeof SETTLED_KINDS)[number];
const isSettled = (kind: string): kind is SettledKind => (SETTLED_KINDS as readonly string[]).includes(kind);

/** The providers of a failed turn by why they refused, when every refusal was
 *  settled; null when any was a rate limit, an outage or unexplained, since
 *  asking again may then work. `last` is the failure the call ended on, for a
 *  turn whose plan was one step. Pure. */
export function settledRefusals(
    refusals: ReadonlyArray<{ step: { option: { providerName: string } }; kind: string }>,
    last: string
): Map<SettledKind, string[]> | null {
    if (!isSettled(last)) return null;
    if (refusals.some((entry) => !isSettled(entry.kind))) return null;
    const byKind = new Map<SettledKind, string[]>();
    for (const { step, kind } of refusals) {
        const reason = kind === "paid" ? "credit" : (kind as SettledKind);
        const names = byKind.get(reason) ?? [];
        if (!names.includes(step.option.providerName)) names.push(step.option.providerName);
        byKind.set(reason, names);
    }
    return byKind.size > 0 ? byKind : null;
}

/** Each settled reason with its words, in the order they are listed. */
const REASON_WORDS = [
    ["credit", "polar.refusedBy.credit"],
    ["key", "polar.refusedBy.key"],
    ["model", "polar.refusedBy.model"]
] as const;

/** What Polar says when every provider refused for good: who, why, and the way to fix it. */
export function providersRefusedText(words: Words, refused: Map<SettledKind, string[]>): string {
    const reasons = REASON_WORDS.filter(([kind]) => refused.has(kind)).map(([kind, key]) =>
        words(key, { providers: refused.get(kind)!.join(", ") })
    );
    return [
        words("polar.providersRefused", { reasons: reasons.join("; ") }),
        `[${words("polar.setUpProviders")}](/polar/settings/providers)`
    ].join(" ");
}

export interface MentionAnswer {
    readonly text: string;
    /** Null when Polar answered. */
    readonly problem: MentionProblem | null;
    /** The change the answer stopped on, waiting for the asker's approval. */
    readonly pending?: PendingCall | null;
}

/** Polar's answer to one mention, or the sentence that says why there is none. Never throws for a model failure. */
export async function answerMention(turn: MentionTurn): Promise<string> {
    return (await answerMentionWithReason(turn)).text;
}

/** The same, saying why when there is no answer. */
export async function answerMentionWithReason(turn: MentionTurn): Promise<MentionAnswer> {
    const { userId, words } = turn;
    const fail = (problem: MentionProblem, text: string): MentionAnswer => ({ text, problem });
    const [{ polarAccessFor }, { rateLimit }] = await Promise.all([
        import("@/lib/polar/access"),
        import("@/lib/rate-limit-service")
    ]);
    const access = await polarAccessFor(userId);
    if (!access.use) return fail("notAvailable", words("polar.notAvailable"));
    // The panel's own ceiling: a mention is a Polar turn like any other.
    const allowed = await rateLimit(`polar-chat:${userId}`, 30, 60_000);
    if (!allowed.ok) return fail("tooFast", words("polar.tooFast"));

    const [
        { answeredBy },
        { automaticChoice },
        { PLAIN_TURN, noteModelEchoed, noteToolMarkup, toolMarkupIn },
        usage,
        { echoesPrompt },
        plan
    ] =
        await Promise.all([
            import("@/lib/polar/models"),
            import("@/lib/polar/shared"),
            import("@/lib/polar/automatic"),
            import("@/lib/polar/usage"),
            import("@/lib/polar/mention-echo"),
            import("@/lib/polar/turn-plan")
        ]);
    const { withoutPseudoToolCalls } = await import("@/lib/polar/pseudo-tools");
    const echo = { prompt: turn.prompt, question: turn.echo?.question ?? "", names: turn.echo?.names ?? [] };

    const signals = {
        ...PLAIN_TURN,
        contextChars: turn.system.length + turn.prompt.length,
        lastChars: turn.prompt.length,
        agentic: !!turn.toolkit
    };
    turn.typing?.();
    const dots = turn.typing ? setInterval(turn.typing, TYPING_EVERY_MS) : null;
    try {
        for (let tries = 0; tries < ECHO_TRIES; tries++) {
            // Planned as the Polar panel plans a turn (`turn-plan.ts`): the
            // model this person talks to Polar with, its subscription and
            // stand-ins included, and a turn offered tools never goes to a
            // model too small to call them. Resolved again after an echo, on
            // Automatic, which leaves the model that echoed out
            // (`noteModelEchoed`), so the next candidate answers.
            const picked = tries === 0 ? await plan.lastPolarChoice(userId) : automaticChoice();
            const planned = await plan.planPolarTurn(userId, picked, signals, access);
            const resolved = typeof planned === "string" ? planned : planned.resolved;
            if (typeof resolved === "string") {
                return tries === 0
                    ? fail("noProvider", noProviderText(words, access.spend))
                    : fail("failed", words("polar.failed"));
            }
            if (resolved.credential.source === "instance" && (await usage.polarLimitReached(userId))) {
                return fail("limitReached", words("polar.limitReached"));
            }
            let text: string;
            let spent: Parameters<typeof usage.answerUsage>[0];
            const kit = turn.toolkit ?? null;
            const stepMax = turn.steps ?? 1;
            try {
                const answer = await generateText({
                    // The router retries and walks keys and fallbacks itself.
                    maxRetries: 0,
                    model: resolved.model,
                    maxOutputTokens: ANSWER_TOKENS,
                    system: turn.system,
                    prompt: turn.prompt,
                    ...(kit
                        ? {
                              tools: kit.tools,
                              activeTools: kit.first,
                              // What discovery found is sent from the next
                              // step on, and the last step has to answer.
                              prepareStep: async ({ stepNumber, steps }: { stepNumber: number; steps: readonly unknown[] }) => {
                                  const { nextStep } = await import("@/lib/polar/tool-relevance");
                                  return nextStep(stepNumber, stepMax, steps as never, kit.activeFor);
                              },
                              // A change asked for ends the turn: it waits for
                              // the asker, not for the model.
                              stopWhen: [stepCountIs(stepMax), () => kit.pending() !== null]
                          }
                        : {})
                });
                text = answer.text;
                spent = answer.totalUsage;
            } catch (error) {
                const { classifyProviderFailure, failureLogLine } = await import("@/lib/polar/provider-failure");
                const failure = classifyProviderFailure(error);
                const refusals = resolved.routed?.refusals() ?? [];
                // Named for the step that refused last, not the one chosen: a
                // walk that ended on Cerebras's refusal must not say Mistral.
                const last = refusals.at(-1)?.step.option.providerName ?? resolved.option.providerName;
                console.warn(failureLogLine(turn.where, last, failure, error));
                const refused = settledRefusals(
                    refusals.length > 0 ? refusals : [{ step: resolved, kind: failure.kind }],
                    failure.kind
                );
                return refused
                    ? fail("providersRefused", providersRefusedText(words, refused))
                    : fail("failed", words("polar.failed"));
            }

            const answered = answeredBy(resolved);
            const payer = answered.credential.source === "instance" ? "instance" : "own";
            try {
                await usage.recordPolarUsage({
                    userId,
                    threadId: null,
                    messageId: null,
                    provider: answered.option.provider,
                    model: answered.option.model,
                    payer,
                    usage: usage.answerUsage(spent, answered.option),
                    ...usage.routeRecord(resolved)
                });
            } catch (error) {
                console.error(`polar: could not record the usage of ${turn.where}:`, error);
            }
            const who = `${answered.option.provider}/${answered.option.model}`;
            // A tool call written out as text - `<invoke name=...>`, a model's
            // own chat-template markup - is nothing anybody should read, and
            // nothing ran. Kept off turns with tools for a while, as the panel
            // does, and the next model is asked.
            if (toolMarkupIn(text)) {
                console.warn(`polar: ${who} wrote its tool calls as text for ${turn.where}; asking the next model`);
                noteToolMarkup(userId, answered.option.provider, answered.option.model);
                continue;
            }
            const said = withoutPseudoToolCalls(text).trim();
            const pending = kit?.pending() ?? null;
            if (pending) {
                console.info(`polar: ${turn.where} answered by ${who} (${payer}), asking to run ${pending.tool}`);
                return { text: said && !echoesPrompt(said, echo) ? said : "", problem: null, pending };
            }
            if (said && !echoesPrompt(said, echo)) {
                console.info(`polar: ${turn.where} answered by ${who} (${payer})`);
                return { text: said, problem: null };
            }
            // Nothing, or the prompt handed back: that model failed this turn.
            console.warn(`polar: ${who} ${said ? "echoed its prompt" : "answered nothing"} for ${turn.where}; asking the next model`);
            noteModelEchoed(userId, answered.option.provider, answered.option.model);
        }
    } finally {
        if (dots) clearInterval(dots);
    }
    return fail("failed", words("polar.failed"));
}

/** The question with the mention taken out; empty when only the mention was written. */
export function questionOf(body: string): string {
    return body.replace(/(^|[^\w@])@polar(?![\w-])/gi, "$1").trim();
}

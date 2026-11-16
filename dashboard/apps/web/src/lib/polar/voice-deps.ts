/**
 * What the voice delegator's tools act with, bound to one person: the same
 * Code functions the screen uses, so a tool can do nothing the person could
 * not do there. Shared by the delegator's turn (`/api/polar/voice/delegate`)
 * and a realtime call's tool calls (`/api/polar/voice/realtime/tool`).
 *
 * Server-only.
 */

import type { SessionUser } from "@/lib/session";
import type { DelegateDeps } from "@/lib/polar/voice-delegate";
import {
    polarCodeInterrupt,
    polarCodeModel,
    polarCodeModels,
    polarCodeOverview,
    polarCodePrompt,
    polarCodeStartLike,
    polarCodeThread
} from "@/lib/polar/code";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true }
        );
    });
}

export function delegateDeps(user: SessionUser): DelegateDeps {
    return {
        list: async () => (await polarCodeOverview(user)).sessions,
        thread: (sessionId) => polarCodeThread(user, sessionId),
        prompt: (sessionId, text) => polarCodePrompt(user, { sessionId, text, attachments: [] }),
        interrupt: (sessionId) => polarCodeInterrupt(user, { sessionId }),
        model: (sessionId, model) => polarCodeModel(user, { sessionId, model }),
        models: (sessionId) => polarCodeModels(user, sessionId),
        create: (input) => polarCodeStartLike(user, input),
        sleep
    };
}

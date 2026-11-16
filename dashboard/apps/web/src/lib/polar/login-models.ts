/**
 * The chat clients for the providers Polar reaches through a subscription
 * login rather than a key: GitHub Copilot and GitLab Duo. xAI's login needs
 * nothing here - its access token is a bearer on the endpoint an xAI key uses.
 */

import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ChatCredential } from "@/lib/agents/model-keys";
import {
    copilotBaseUrl,
    copilotChatHeaders,
    copilotEndpoint,
    copilotListsModel
} from "@/lib/agents/signin-copilot";
import { loginRequest, type LoginRequest } from "@/lib/agents/provider-login-http";
import {
    DIRECT_ACCESS_TTL_MS,
    GITLAB_ANTHROPIC_BASE,
    GITLAB_OPENAI_BASE,
    duoModel,
    gitlabDirectAccess,
    type DirectAccess
} from "@/lib/agents/signin-gitlab";

/**
 * Nothing is kept on Copilot's side between turns: every turn sends the whole
 * conversation, with reasoning carried encrypted instead of by a stored id
 * Copilot may not hold (OpenCode's `openai-compatible-responses.ts` defaults).
 */
const STATELESS_RESPONSES: LanguageModelMiddleware = {
    transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
            ...params.providerOptions,
            openai: {
                store: false,
                include: ["reasoning.encrypted_content"],
                ...params.providerOptions?.openai
            }
        }
    })
};

/** A Copilot model on the API that answers it: `/responses` for the models
 *  served only there, `/chat/completions` for the rest (`copilotEndpoint`). */
/**
 * Whether a catalogue model is offered on a login provider. Copilot drops one
 * alias; every other provider lists what the catalogue carries. Pure.
 */
export function loginListsModel(provider: string, model: string): boolean {
    if (provider === "github-copilot") return copilotListsModel(model);
    return true;
}

export function copilotModel(credential: ChatCredential, model: string): LanguageModel {
    const baseURL = copilotBaseUrl(credential.oauth?.apiEndpoint);
    const headers = copilotChatHeaders();
    if (copilotEndpoint(model) === "responses") {
        const client = createOpenAI({ name: "github-copilot", baseURL, apiKey: credential.secret, headers });
        return wrapLanguageModel({ model: client.responses(model), middleware: STATELESS_RESPONSES });
    }
    return createOpenAICompatible({ name: "github-copilot", baseURL, apiKey: credential.secret, headers })(model);
}

/** Gateway tokens by the GitLab access token they were issued for, shared by
 *  every chat on that login until a few minutes before they end. */
const directTokens = new Map<string, { until: number; value: Promise<DirectAccess> }>();
const MAX_CACHED = 1000;

export function directAccessFor(
    access: string,
    request: LoginRequest = loginRequest,
    now = Date.now()
): Promise<DirectAccess> {
    const held = directTokens.get(access);
    if (held && held.until > now) return held.value;
    if (directTokens.size >= MAX_CACHED) directTokens.clear();
    const value = gitlabDirectAccess(request, access);
    directTokens.set(access, { until: now + DIRECT_ACCESS_TTL_MS, value });
    value.catch(() => directTokens.delete(access));
    return value;
}

/** Every request to GitLab's gateway carries its token and the headers GitLab
 *  issued with it, in place of whatever the client set. */
function duoFetch(access: string): typeof fetch {
    return async (input, init) => {
        const direct = await directAccessFor(access);
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        headers.set("Authorization", `Bearer ${direct.token}`);
        for (const [name, value] of Object.entries(direct.headers)) headers.set(name, value);
        return fetch(input, { ...init, headers });
    };
}

export function gitlabModel(credential: ChatCredential, model: string): LanguageModel {
    const upstream = duoModel(model);
    if (!upstream) throw new Error(`polar: GitLab Duo does not serve ${model}`);
    const fetch = duoFetch(credential.secret);
    // The token is set per request by the fetch above; the placeholders only
    // satisfy the clients' own check that one is configured.
    if (upstream.api === "anthropic") {
        return createAnthropic({ authToken: "gitlab-duo", baseURL: GITLAB_ANTHROPIC_BASE, fetch })(upstream.model);
    }
    const openai = createOpenAI({ apiKey: "gitlab-duo", baseURL: GITLAB_OPENAI_BASE, fetch });
    return upstream.api === "openai-chat" ? openai.chat(upstream.model) : openai.responses(upstream.model);
}

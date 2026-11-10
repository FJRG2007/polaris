/**
 * How many tokens a request will read, estimated the way free-claude-code's
 * `core/anthropic/tokens.py` does: each block by its kind, plus the same
 * per-message, per-tool and per-block overheads. free-claude-code counts text
 * with a bundled cl100k encoder and falls back to a quarter of the
 * characters; no model's own tokenizer is reachable from here and every
 * provider's differs, so this uses that fallback throughout. Claude Code
 * reads the count only to decide when to compact, where a close estimate is
 * what it needs.
 *
 * Pure.
 */

import type { AnthropicBlock, MessagesRequest } from "@/lib/polar/compat/anthropic-request";

/** A quarter of the characters, the fallback of `estimate_text_tokens`. */
export function textTokens(text: string): number {
    return text ? Math.max(1, Math.floor(text.length / 4)) : 0;
}

/** An image by its base64 size, or a flat cost without data
 *  (`estimate_image_tokens`). */
export function imageTokens(base64Length?: number): number {
    return base64Length ? Math.max(85, Math.floor(base64Length / 3000)) : 765;
}

function imageBlockTokens(block: { source?: unknown }): number {
    const source = block.source as { data?: unknown } | undefined;
    return typeof source?.data === "string" && source.data ? imageTokens(source.data.length) : imageTokens();
}

function blockTokens(block: AnthropicBlock): number {
    const value = block as Record<string, unknown>;
    switch (block.type) {
        case "text":
            return textTokens(String(value.text ?? ""));
        case "thinking":
            return textTokens(String(value.thinking ?? ""));
        case "tool_use":
            return (
                textTokens(String(value.name ?? "")) +
                textTokens(JSON.stringify(value.input ?? {})) +
                textTokens(String(value.id ?? "")) +
                15
            );
        case "image":
            return imageBlockTokens(value);
        case "tool_result": {
            const content = value.content;
            let total = 0;
            if (typeof content === "string") total += textTokens(content);
            else if (Array.isArray(content)) {
                // An image a tool returned is priced like any image, not by
                // its base64 read as text.
                const images = content.filter((part) => part?.type === "image");
                const others = content.filter((part) => part?.type !== "image");
                total += images.reduce((sum, image) => sum + imageBlockTokens(image), 0);
                if (others.length > 0 || images.length === 0) total += textTokens(JSON.stringify(others));
            } else total += textTokens(JSON.stringify(content ?? ""));
            return total + textTokens(String(value.tool_use_id ?? "")) + 8;
        }
        case "server_tool_use":
        case "web_search_tool_result":
        case "web_fetch_tool_result":
            return textTokens(JSON.stringify(block)) + 12;
        default:
            return textTokens(JSON.stringify(block));
    }
}

/** The estimate for a whole request, never below one. */
export function countRequestTokens(request: Pick<MessagesRequest, "messages" | "system" | "tools">): number {
    let total = 0;
    const system = request.system;
    if (system && (typeof system === "string" || system.length > 0)) {
        total +=
            typeof system === "string"
                ? textTokens(system)
                : system.reduce((sum, block) => sum + textTokens(block.text), 0);
        total += 4;
    }
    for (const message of request.messages) {
        if (typeof message.content === "string") total += textTokens(message.content);
        else for (const block of message.content) total += blockTokens(block);
    }
    const tools = request.tools ?? [];
    for (const tool of tools) {
        total += textTokens(tool.name + (tool.description ?? "") + JSON.stringify(tool.input_schema ?? {}));
    }
    total += request.messages.length * 4 + tools.length * 5;
    return Math.max(1, total);
}

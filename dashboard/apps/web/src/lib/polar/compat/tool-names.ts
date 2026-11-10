/**
 * Tool names every provider accepts. OpenAI-style APIs take only
 * `^[A-Za-z0-9_-]{1,64}$`, and a coding tool's names do not always fit: an MCP
 * tool is `mcp__server__tool.name`, and a long server name runs past 64. A
 * name that does not fit is sent as a readable alias with a digest of the
 * original, and every name the model answers with is mapped back, so the
 * client only ever sees its own names. Follows free-claude-code's
 * `core/openai_tool_names.py` exactly: same pattern, same 64-character
 * ceiling, the name's invalid runs replaced by `_`, cut to leave room for `_`
 * and a 16-character SHA-256 digest, and a new digest on a clash.
 *
 * The aliases depend only on the set of names, never on their order, so the
 * same conversation maps the same way on every request.
 */

import { createHash } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import type { SdkToolChoice } from "@/lib/polar/compat/anthropic-request";

export const TOOL_NAME_MOST = 64;
const DIGEST_LENGTH = 16;
const PORTABLE = /^[A-Za-z0-9_-]{1,64}$/;
const INVALID = /[^A-Za-z0-9_-]+/g;

/** `_`, `-` trimmed from both ends, as Python's `strip("_-")`. */
const trimmed = (value: string) => value.replace(/^[_-]+|[_-]+$/g, "");

function aliasOf(name: string, reserved: ReadonlySet<string>): string {
    let readable = trimmed(name.replace(INVALID, "_")) || "tool";
    readable = readable.slice(0, TOOL_NAME_MOST - DIGEST_LENGTH - 1).replace(/[_-]+$/, "") || "tool";
    for (let attempt = 0; ; attempt += 1) {
        const input = attempt === 0 ? name : `${name}\0${attempt}`;
        const digest = createHash("sha256").update(input, "utf8").digest("hex").slice(0, DIGEST_LENGTH);
        const alias = `${readable}_${digest}`;
        if (!reserved.has(alias)) return alias;
    }
}

export interface ToolNameCodec {
    readonly hasAliases: boolean;
    encode(name: string): string;
    decode(name: string): string;
}

export function toolNameCodec(names: Iterable<string>): ToolNameCodec {
    const unique = new Set([...names].filter(Boolean));
    const portable = new Set([...unique].filter((name) => PORTABLE.test(name)));
    const reserved = new Set(portable);
    const toAlias = new Map<string, string>();
    const fromAlias = new Map<string, string>();
    // Sorted as Python sorts strings, by code point.
    const odd = [...unique].filter((name) => !portable.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of odd) {
        const alias = aliasOf(name, reserved);
        reserved.add(alias);
        toAlias.set(name, alias);
        fromAlias.set(alias, name);
    }
    return {
        hasAliases: toAlias.size > 0,
        encode: (name) => toAlias.get(name) ?? name,
        decode: (name) => fromAlias.get(name) ?? name
    };
}

/** Every tool name a call carries: its tools, its tool choice and the calls
 *  and results in its history. */
export function toolNamesOf(input: {
    tools?: ToolSet;
    toolChoice?: SdkToolChoice;
    messages: readonly ModelMessage[];
}): string[] {
    const names = Object.keys(input.tools ?? {});
    if (typeof input.toolChoice === "object") names.push(input.toolChoice.toolName);
    for (const message of input.messages) {
        if (typeof message.content === "string") continue;
        for (const part of message.content) {
            if (part.type === "tool-call" || part.type === "tool-result") names.push(part.toolName);
        }
    }
    return names;
}

/** The call with every tool name in its wire form. */
export function encodeToolNames<T extends { tools?: ToolSet; toolChoice?: SdkToolChoice; messages: ModelMessage[] }>(
    input: T,
    codec: ToolNameCodec
): T {
    if (!codec.hasAliases) return input;
    const tools = input.tools
        ? Object.fromEntries(Object.entries(input.tools).map(([name, tool]) => [codec.encode(name), tool]))
        : undefined;
    const toolChoice =
        typeof input.toolChoice === "object"
            ? { type: "tool" as const, toolName: codec.encode(input.toolChoice.toolName) }
            : input.toolChoice;
    const messages = input.messages.map((message): ModelMessage => {
        if (typeof message.content === "string") return message;
        return {
            ...message,
            content: message.content.map((part) =>
                part.type === "tool-call" || part.type === "tool-result"
                    ? { ...part, toolName: codec.encode(part.toolName) }
                    : part
            )
        } as ModelMessage;
    });
    return { ...input, tools, toolChoice, messages };
}

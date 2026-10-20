/**
 * The model reads back the call it made in the words it made it in, so an
 * approved door opens once.
 *
 * The door tool's schema turns the spoken "open" into its internal "unlatch".
 * Handed to the AI SDK as-is, the rewritten input is what the history keeps:
 * on the next step the model saw itself call action "unlatch" - not one of the
 * words it is offered - decided it had used the wrong one, and asked to open
 * the door again (a real chat, 2026-10-20). Polar's input schema checks with
 * the tool's schema but keeps what the model wrote; the tool parses it when it
 * runs (`tools.ts`).
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { polarInputSchema } from "@/lib/polar/tool-input";
import { generateText, tool, type ModelMessage } from "ai";

const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

const DOOR = "01a079c0-1509-7ae3-9e96-edbb266957cb";

/** The door tool's shape: a spoken word in, the internal action out. */
const doorInput = z.object({
    deviceId: z.string().uuid(),
    action: z.enum(["open", "lock"]).transform((word) => (word === "open" ? "unlatch" : word)),
    note: z.string().trim().max(40).optional()
});

function model(turns: Array<"call" | "done">) {
    let at = 0;
    return new MockLanguageModelV4({
        doGenerate: async () => {
            const turn = turns[at++] ?? "done";
            return turn === "call"
                ? {
                      content: [
                          {
                              type: "tool-call" as const,
                              toolCallId: `call-${at}`,
                              toolName: "door",
                              input: JSON.stringify({ deviceId: DOOR, action: "open" })
                          }
                      ],
                      finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
                      usage: USAGE,
                      warnings: []
                  }
                : {
                      content: [{ type: "text" as const, text: "Opened." }],
                      finishReason: { unified: "stop" as const, raw: "stop" },
                      usage: USAGE,
                      warnings: []
                  };
        }
    });
}

/** Ask to open the door, press Run it, and go on: what ran and what the model reads. */
async function approveAndGoOn(inputSchema: Parameters<typeof tool>[0]["inputSchema"]) {
    const ran: unknown[] = [];
    const door = tool({
        inputSchema,
        execute: async (input: unknown) => {
            ran.push(input);
            return { ok: true };
        }
    });
    const tools = { door };
    const toolApproval = { door: async () => "user-approval" as const };

    const first = await generateText({
        model: model(["call"]),
        tools,
        toolApproval,
        prompt: "abrela"
    });
    const request = first.content.find((part) => part.type === "tool-approval-request");
    expect(request).toBeTruthy();
    expect(ran).toEqual([]);

    const messages: ModelMessage[] = [
        { role: "user", content: "abrela" },
        ...first.response.messages,
        {
            role: "tool",
            content: [
                {
                    type: "tool-approval-response",
                    approvalId: (request as { approvalId: string }).approvalId,
                    approved: true
                }
            ]
        }
    ];
    const second = await generateText({ model: model(["done"]), tools, toolApproval, messages });
    const call = first.response.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((part) => part.type === "tool-call") as { input: unknown } | undefined;
    const asksAgain = second.content.some((part) => part.type === "tool-approval-request");
    return { ran, readBack: call?.input, asksAgain };
}

describe("an approved door call", () => {
    it("reads back as the internal word with the tool's schema alone (the bug)", async () => {
        const { readBack } = await approveAndGoOn(doorInput);
        expect(readBack).toMatchObject({ action: "unlatch" });
    });

    it("reads back as the model wrote it, and runs once, through Polar's schema", async () => {
        const { ran, readBack, asksAgain } = await approveAndGoOn(polarInputSchema(doorInput));
        expect(readBack).toEqual({ deviceId: DOOR, action: "open" });
        expect(ran).toEqual([{ deviceId: DOOR, action: "open" }]);
        expect(asksAgain).toBe(false);
        // The tool parses it when it runs, as tools.ts does.
        expect(doorInput.parse(ran[0])).toEqual({ deviceId: DOOR, action: "unlatch" });
    });

    it("still refuses input the tool does not take", async () => {
        const checked = await polarInputSchema(doorInput).validate?.({
            deviceId: DOOR,
            action: "smash"
        });
        expect(checked?.success).toBe(false);
    });
});

/**
 * A tool's own failure, told apart from the model provider's.
 *
 * The AI SDK hands every error of a turn to one `onError` - the provider's
 * refusal on the stream, and a tool call that could not be read or whose tool
 * threw - so a tool that failed was shown as `OpenRouter could not answer`
 * (its error text the encoded provider failure), and counted against the
 * provider as a refusal. A tool's errors are tagged here when it runs
 * (`withTaggedToolErrors`), and the SDK's own tool-call errors are known by
 * type, so the route tells the reader which of the two it was.
 *
 * Server-only.
 */

import { InvalidToolInputError, NoSuchToolError, ToolCallRepairError, type ToolSet } from "ai";

/** An error a tool's `execute` threw, with the tool's name on it. */
export class ToolFailure extends Error {
    constructor(
        readonly toolName: string,
        readonly error: unknown
    ) {
        super(`${toolName} failed`);
        this.name = "ToolFailure";
        this.cause = error;
    }
}

/** Whether an error belongs to a tool call rather than to the provider. Pure. */
export function isToolFailure(error: unknown): boolean {
    return (
        error instanceof ToolFailure ||
        InvalidToolInputError.isInstance(error) ||
        NoSuchToolError.isInstance(error) ||
        ToolCallRepairError.isInstance(error) ||
        // The SDK passes an invalid dynamic call's error on as its message.
        typeof error === "string"
    );
}

/**
 * What a tool call's failure says on its card: which tool and what went wrong
 * with the call, never the error's own text, which can name internals. Pure.
 */
export function toolFailureText(error: unknown): string {
    if (InvalidToolInputError.isInstance(error)) {
        return `${error.toolName} was called with input it does not take.`;
    }
    if (NoSuchToolError.isInstance(error)) {
        return `There is no tool named ${error.toolName} in this chat.`;
    }
    if (ToolCallRepairError.isInstance(error)) return "The tool call could not be read.";
    if (error instanceof ToolFailure) return `${error.toolName} failed before it answered.`;
    return "The tool call failed.";
}

/** Every tool of a set, its `execute` tagging what it throws as a `ToolFailure`. */
export function withTaggedToolErrors<T extends ToolSet>(tools: T): T {
    const tagged: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(tools)) {
        const run = (entry as { execute?: (...args: never[]) => unknown }).execute;
        tagged[name] = run
            ? {
                  ...entry,
                  execute: async (...args: never[]) => {
                      try {
                          return await run(...args);
                      } catch (error) {
                          throw error instanceof ToolFailure ? error : new ToolFailure(name, error);
                      }
                  }
              }
            : entry;
    }
    return tagged as T;
}

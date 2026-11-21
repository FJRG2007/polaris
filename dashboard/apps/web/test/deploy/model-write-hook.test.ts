/**
 * The database hook every write passes through: with nobody listening it does
 * nothing, a listener only hears the models it asked for, and a listener that
 * throws never turns a write that landed into a failure.
 */

import { describe, expect, it, vi } from "vitest";
import { announcingAccessWrites, onModelWrite } from "@polaris/db";

type Handler = (input: {
    model: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

/** The `$allOperations` handler the extension installs, without a database. */
function handler(): Handler {
    let installed: Handler | null = null;
    const base = {
        $extends: (config: { query: { $allModels: { $allOperations: Handler } } }) => {
            installed = config.query.$allModels.$allOperations;
            return base;
        }
    };
    announcingAccessWrites(base as never);
    return installed!;
}

describe("the model write hook", () => {
    it("answers the write's result with nobody listening", async () => {
        const run = handler();
        const query = vi.fn(async () => ({ id: "row" }));
        await expect(
            run({ model: "Deployment", operation: "update", args: { where: { id: "a" } }, query })
        ).resolves.toEqual({ id: "row" });
        expect(query).toHaveBeenCalledOnce();
    });

    it("tells a listener about writes to its models only, never reads", async () => {
        const run = handler();
        const heard: string[] = [];
        const stop = onModelWrite(["Deployment"], (write) => heard.push(`${write.model}.${write.operation}`));
        const query = async () => null;
        await run({ model: "Deployment", operation: "update", args: {}, query });
        await run({ model: "Deployment", operation: "findMany", args: {}, query });
        await run({ model: "Application", operation: "update", args: {}, query });
        stop();
        await run({ model: "Deployment", operation: "delete", args: {}, query });
        expect(heard).toEqual(["Deployment.update"]);
    });

    it("never fails a write because a listener threw", async () => {
        const run = handler();
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const stop = onModelWrite(["Deployment"], () => {
            throw new Error("listener broke");
        });
        await expect(
            run({ model: "Deployment", operation: "update", args: {}, query: async () => "done" })
        ).resolves.toBe("done");
        stop();
        error.mockRestore();
    });
});

import { describe, expect, it } from "vitest";
import * as progress from "@/lib/computers/computer-progress";

const SESSION = "4a1f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c";
const words = { failure: (code: string) => `failure:${code}`, other: "could not start" };

describe("computer progress", () => {
    it("keeps the newest step per session and lets it expire", () => {
        progress.recordComputerProgress(SESSION, { tool: "git", step: "download", received: 1, total: 4 }, 0);
        progress.recordComputerProgress(SESSION, { tool: "node", step: "install" }, 10);
        expect(progress.computerProgress(SESSION, 20)).toEqual({ tool: "node", step: "install" });
        expect(progress.computerProgress(SESSION, 10 * 60_000 + 11)).toBeNull();
    });

    it("forgets a session once it started", () => {
        progress.recordComputerProgress(SESSION, { tool: "git", step: "ready" });
        progress.forgetComputerProgress(SESSION);
        expect(progress.computerProgress(SESSION)).toBeNull();
    });

    it("says a runner's end words in the reader's language and passes an older sentence through", () => {
        expect(progress.toolchainEndDetail("toolchain:node:offline", words)).toBe("failure:offline");
        expect(progress.toolchainEndDetail("toolchain:node:nonsense", words)).toBe("could not start");
        expect(progress.toolchainEndDetail("git:clone", words)).toBe("could not start");
        expect(progress.toolchainEndDetail("The agent exited.", words)).toBe("The agent exited.");
        expect(progress.toolchainEndDetail(null, words)).toBeNull();
    });
});

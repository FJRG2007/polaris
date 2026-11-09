import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/session-ports", () => ({ withContainerPorts: vi.fn() }));
vi.mock("@/lib/agents/session-service", () => ({ sessionPlacement: vi.fn() }));
vi.mock("@/lib/agents/session-work", () => ({ DEFAULT_WORKDIR: "/session/repo" }));

const { checkoutPath } = await import("@/lib/agents/session-files");

describe("a path a reader asks to open in a session's checkout", () => {
    it("keeps a path inside the checkout", () => {
        expect(checkoutPath("src/app.ts")).toBe("src/app.ts");
        expect(checkoutPath("./README.md")).toBe("README.md");
    });

    it("refuses one that leaves it or names the whole machine", () => {
        for (const path of ["../etc/passwd", "src/../../x", "/etc/passwd", "", "a//b", "a\nb"]) {
            expect(checkoutPath(path)).toBeNull();
        }
    });
});

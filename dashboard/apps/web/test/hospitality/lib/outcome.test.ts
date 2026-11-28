/**
 * How a Hospitality action answers. A refusal is about the order and is shown
 * as written; a failure on the server's side (the database restarting under an
 * update) is marked `retry`, so a handheld keeps the write queued rather than
 * dropping an order the server never judged.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/app-host", () => ({
    host: { session: { requirePermission: async () => ({ id: "waiter-1", name: "Ana" }) } }
}));
vi.mock("@polaris-app/hospitality/src/lib/i18n", () => ({ hospitalityT: async () => (key: string) => key }));

const { HospitalityRefusal, outcome } = await import("@polaris-app/hospitality/src/lib/outcome");

describe("a hospitality action's outcome", () => {
    it("answers a refusal without retry", async () => {
        const answer = await outcome("hospitality.use", async () => {
            throw new HospitalityRefusal("orders.soldOut" as never);
        });
        expect(answer).toEqual({ ok: false, error: "orders.soldOut" });
    });

    it("marks a server-side failure for retry without naming it", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const answer = await outcome("hospitality.use", async () => {
            throw new Error("Can't reach database server at `db:5432`");
        });
        expect(answer).toEqual({ ok: false, error: "errors.generic", retry: true });
    });
});

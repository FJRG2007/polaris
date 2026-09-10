/**
 * What the Deploy API says when something fails.
 *
 * The line this pins is between a refusal the caller can act on and the inside
 * of the instance. The service layer's own sentences ("That deploy has already
 * finished") are passed on, because a CLI that answers every refusal with "could
 * not deploy" is useless; a daemon's error, a driver's error or anything naming a
 * path is kept for the server log.
 */

import { describe, expect, it, vi } from "vitest";
import { DeployApiRefusal, publicFailure } from "@/lib/deploy/api/refusal";

describe("publicFailure", () => {
    it("passes a refusal through with its own status", () => {
        expect(publicFailure(new DeployApiRefusal(409, "Two services match."), "deploy")).toEqual({
            status: 409,
            message: "Two services match."
        });
    });

    it("answers every flavour of not found with the same 404", () => {
        for (const said of ["Project not found", "Application not found", "Deployment not found"]) {
            expect(publicFailure(new Error(said), "deploy")).toEqual({
                status: 404,
                message: "Not found"
            });
        }
    });

    it("passes on a sentence the service layer wrote for a person", () => {
        expect(publicFailure(new Error("That deploy has already finished"), "cancel")).toEqual({
            status: 422,
            message: "That deploy has already finished"
        });
        expect(
            publicFailure(
                new Error("api.example.test is already in use by another service."),
                "add"
            )
        ).toMatchObject({ status: 422 });
    });

    it("keeps anything from beneath the service layer out of the answer", () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const leaks = [
            new Error("hostd docker proxy failed (502): bind /var/lib/polaris/deploy"),
            new Error("connect ECONNREFUSED 10.0.0.4:2375"),
            new Error("first line\nsecond line"),
            Object.assign(new Error("database is down"), { code: "P1001" }),
            new TypeError("Cannot read properties of undefined"),
            "a thrown string"
        ];
        for (const leak of leaks) {
            const failure = publicFailure(leak, "deploy the service");
            expect(failure.status).toBe(500);
            expect(failure.message).toBe(
                "Polaris could not deploy the service. The reason has been logged on the server."
            );
        }
        expect(quiet).toHaveBeenCalledTimes(leaks.length);
        quiet.mockRestore();
    });
});

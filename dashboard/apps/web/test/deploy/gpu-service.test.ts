/**
 * Turning a service's GPU on or off: refused where its machine has no card,
 * saved before the container is started again, and still saved - and said so -
 * when that restart fails, so the switch keeps showing what is stored.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, update, restartFromKeptImage, machineGpus } = vi.hoisted(() => ({
    findFirst: vi.fn(),
    update: vi.fn(),
    restartFromKeptImage: vi.fn(),
    machineGpus: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: { application: { findFirst, update } } }));
vi.mock("@/lib/deploy-service", () => ({ restartFromKeptImage }));
vi.mock("@/lib/gpu/gpu-live", () => ({ machineGpus }));

import { setServiceGpu } from "@/lib/deploy/gpu-service";

const APP = {
    useGpu: false,
    currentDeploymentId: "deployment-1",
    target: { kind: "local", hostId: null, runtime: "docker" }
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    findFirst.mockResolvedValue(APP);
    update.mockResolvedValue({});
    restartFromKeptImage.mockResolvedValue("deployment-2");
    machineGpus.mockReturnValue({ at: 0, gpus: [{ index: 0 }], containers: new Map() });
});

describe("turning a service's GPU on or off", () => {
    it("saves it and starts the running release again", async () => {
        const outcome = await setServiceGpu("app-1", "owner-1", "user-1", true);
        expect(update).toHaveBeenCalledWith({ where: { id: "app-1" }, data: { useGpu: true } });
        expect(outcome).toEqual({ refusal: null, saved: true, redeployed: true, restartFailed: false });
    });

    it("refuses without saving where the machine has no card", async () => {
        machineGpus.mockReturnValue(null);
        const outcome = await setServiceGpu("app-1", "owner-1", "user-1", true);
        expect(outcome.refusal).toBe("noGpu");
        expect(outcome.saved).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it("does nothing when the setting is already what was asked", async () => {
        const outcome = await setServiceGpu("app-1", "owner-1", "user-1", false);
        expect(outcome.saved).toBe(false);
        expect(update).not.toHaveBeenCalled();
        expect(restartFromKeptImage).not.toHaveBeenCalled();
    });

    it("keeps it saved and says the restart failed when the restart throws", async () => {
        restartFromKeptImage.mockRejectedValue(new Error("engine unreachable"));
        const outcome = await setServiceGpu("app-1", "owner-1", "user-1", true);
        expect(update).toHaveBeenCalledOnce();
        expect(outcome).toEqual({ refusal: null, saved: true, redeployed: false, restartFailed: true });
    });
});

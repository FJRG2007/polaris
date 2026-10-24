/**
 * The Tapo control actions on the server: the permission they ask for, the
 * schema they hold a command to, the siren and PTZ rate limits, and the audit
 * row each command leaves. The camera itself is replaced; its protocol is
 * covered by tapo-controls.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CAMERA = "11111111-1111-4111-8111-111111111111";

const requireHome = vi.fn(async (_permission: string) => ({
    user: { id: "user-1" },
    install: { id: "install-1", ownerId: "owner-1" }
}));

vi.mock("@polaris-app/places/src/lib/access", () => ({
    requireHome: (permission: string) => requireHome(permission),
    requireHomeInstall: vi.fn(),
    requireHomeShared: vi.fn()
}));

const tapoCommand = vi.fn(async (..._args: unknown[]) => ({ ptz: false }));
const tapoControls = vi.fn(async (..._args: unknown[]) => ({ ptz: false }));
vi.mock("@polaris-app/places/src/lib/tapo-controls", () => ({
    tapoCommand: (...args: unknown[]) => tapoCommand(...args),
    tapoControls: (...args: unknown[]) => tapoControls(...args)
}));

const move = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@polaris-app/places/src/lib/ptz", async (original) => ({
    ...(await original<typeof import("@polaris-app/places/src/lib/ptz")>()),
    move: (...args: unknown[]) => move(...args)
}));

vi.mock("@polaris-app/places/src/lib/i18n", async (original) => {
    const real = await original<typeof import("@polaris-app/places/src/lib/i18n")>();
    return { ...real, placesT: async () => real.placesTIn("en-US") };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const counts = new Map<string, number>();
const rateLimit = vi.fn(async (key: string, limit: number, _windowMs: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { ok: count <= limit };
});
const recordAudit = vi.fn(async (_entry: Record<string, unknown>) => undefined);

vi.mock("@polaris/app-host", async (original) => {
    const real = await original<typeof import("@polaris/app-host")>();
    const host = real.host as unknown as Record<string, unknown>;
    return {
        ...real,
        host: new Proxy(host, {
            get(target, key) {
                if (key === "rateLimitService")
                    return {
                        rateLimit: (key: string, limit: number, windowMs: number) =>
                            rateLimit(key, limit, windowMs)
                    };
                if (key === "auditService")
                    return { recordAudit: (entry: Record<string, unknown>) => recordAudit(entry) };
                return Reflect.get(target, key);
            }
        })
    };
});

const { tapoCommandAction, tapoControlsAction, ptzMoveAction } =
    await import("@polaris-app/places/src/screens/actions");

beforeEach(() => {
    counts.clear();
    for (const mock of [requireHome, tapoCommand, tapoControls, move, rateLimit, recordAudit])
        mock.mockClear();
});

describe("tapo control actions", () => {
    it("ask for home.control", async () => {
        await tapoControlsAction(CAMERA);
        await tapoCommandAction(CAMERA, { kind: "led", on: true });
        await ptzMoveAction(CAMERA, "left");
        expect(requireHome.mock.calls.map(([permission]) => permission)).toEqual([
            "home.control",
            "home.control",
            "home.control"
        ]);
    });

    it("refuse a malformed command or camera before reaching the camera", async () => {
        expect((await tapoCommandAction(CAMERA, { kind: "siren", on: "yes" })).error).toBeTruthy();
        expect((await tapoCommandAction("not-a-camera", { kind: "reboot" })).error).toBeTruthy();
        expect((await ptzMoveAction(CAMERA, "sideways" as unknown as "left")).error).toBeTruthy();
        expect(tapoCommand).not.toHaveBeenCalled();
        expect(move).not.toHaveBeenCalled();
    });

    it("audit a command that was carried out", async () => {
        await tapoCommandAction(CAMERA, { kind: "siren", on: true });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "places.camera.siren",
                targetType: "camera",
                targetId: CAMERA
            })
        );
    });

    it("limit the siren to six presses a minute per person and camera", async () => {
        for (let press = 0; press < 6; press += 1)
            expect(
                (await tapoCommandAction(CAMERA, { kind: "siren", on: true })).error
            ).toBeUndefined();
        const refused = await tapoCommandAction(CAMERA, { kind: "siren", on: true });
        expect(refused.error).toBe("Too many presses. Wait a minute and try again");
        expect(tapoCommand).toHaveBeenCalledTimes(6);
    });

    it("limit moves to 120 a minute", async () => {
        for (let press = 0; press < 120; press += 1) await ptzMoveAction(CAMERA, "up");
        expect((await ptzMoveAction(CAMERA, "up")).error).toBeTruthy();
        expect(move).toHaveBeenCalledTimes(120);
    });
});

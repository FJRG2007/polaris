/**
 * Off means off, for the one part of Places that costs something while nothing
 * is happening.
 *
 * The recognizer holds its models in memory for as long as it is up, whether or
 * not a camera ever asks it anything, so a house that does not want names on
 * events should not be paying for it. That makes two things worth pinning, and
 * the second is the one a switch usually gets wrong: that the flag is honoured
 * everywhere the recognizer is reached for, and that a house which never said
 * anything counts as not wanting it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the house has written down, which each test sets. */
let secrets: Record<string, unknown> = {};
let written: Record<string, unknown> | null = null;

const setApplicationRunning = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: vi.fn(async () => ({
                encryptedSecret: Buffer.from("x"),
                secretNonce: Buffer.from("y"),
                secretKeyId: "k1",
                applicationId: "app-1",
                ownerId: "owner-1",
                targetId: null
            })),
            update: vi.fn(async () => undefined)
        },
        application: { findFirst: vi.fn(async () => ({ desiredState: "running" })) }
    }
}));
vi.mock("@polaris/storage", () => ({
    decryptSecret: () => JSON.stringify(secrets),
    encryptSecret: (plain: string) => {
        written = JSON.parse(plain) as Record<string, unknown>;
        return { ciphertext: Buffer.from("x"), nonce: Buffer.from("y"), keyId: "k1" };
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "key" }) }));
vi.mock("@/lib/deploy-service", () => ({ setApplicationRunning }));
vi.mock("@/lib/apps/install-service", () => ({ installApp: vi.fn() }));
vi.mock("@/lib/apps/install-secret", () => ({ installEnvSecret: vi.fn(async () => "face-key") }));
vi.mock("@/lib/home/access", () => ({ homeInstall: vi.fn(async () => ({ id: "home-1" })) }));
vi.mock("@/lib/home/side-service", () => ({
    assertServer: vi.fn(),
    findService: vi.fn(async () => null),
    serviceUrls: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:35590",
        directUrl: "http://host.docker.internal:35590",
        networkUrl: "http://marketplace-face-recognition-bb96:8000"
    }))
}));

const { recognizerFor, faceRecognitionSettings, setFaceEnabled } = await import(
    "@/lib/home/recognizer"
);

beforeEach(() => {
    secrets = {};
    written = null;
    setApplicationRunning.mockClear();
});

describe("a house that has never said", () => {
    it("has recognition off", async () => {
        secrets = { faceInstallId: "install-1" };
        expect(await recognizerFor("home-1")).toBeNull();
        expect((await faceRecognitionSettings("home-1")).enabled).toBe(false);
    });

    it("is told when its container is up regardless", async () => {
        // The state a house installed before there was a switch wakes up in.
        // Reporting it as simply "off" would be the opposite of what somebody
        // switching it off asked for.
        secrets = { faceInstallId: "install-1" };
        const settings = await faceRecognitionSettings("home-1");
        expect(settings.enabled).toBe(false);
        expect(settings.running).toBe(true);
    });
});

describe("switched off", () => {
    it("reaches no recognizer, whichever kind the house has", async () => {
        // Its own install, and one somebody runs themselves: both are off.
        secrets = { faceInstallId: "install-1", faceEnabled: false };
        expect(await recognizerFor("home-1")).toBeNull();
        secrets = {
            faceApiUrl: "http://192.168.1.20:8000",
            faceApiKey: "their-key",
            faceEnabled: false
        };
        expect(await recognizerFor("home-1")).toBeNull();
    });

    it("stops the container rather than only ignoring it", async () => {
        secrets = { faceInstallId: "install-1", faceEnabled: true };
        await setFaceEnabled("home-1", false);
        expect(written?.faceEnabled).toBe(false);
        expect(setApplicationRunning).toHaveBeenCalledWith("app-1", "owner-1", false);
    });

    it("keeps a typed address, so turning it back on does not lose it", async () => {
        secrets = { faceApiUrl: "http://192.168.1.20:8000", faceApiKey: "their-key" };
        await setFaceEnabled("home-1", false);
        expect(written?.faceApiUrl).toBe("http://192.168.1.20:8000");
        // Nothing of Polaris' to stop: it never started it.
        expect(setApplicationRunning).not.toHaveBeenCalled();
    });
});

describe("switched on", () => {
    it("reaches the one Home installed", async () => {
        secrets = { faceInstallId: "install-1", faceEnabled: true };
        const endpoint = await recognizerFor("home-1");
        expect(endpoint?.networkUrl).toBe("http://marketplace-face-recognition-bb96:8000");
        expect(endpoint?.apiKey).toBe("face-key");
    });

    it("starts the container with it", async () => {
        secrets = { faceInstallId: "install-1", faceEnabled: false };
        await setFaceEnabled("home-1", true);
        expect(written?.faceEnabled).toBe(true);
        expect(setApplicationRunning).toHaveBeenCalledWith("app-1", "owner-1", true);
    });
});

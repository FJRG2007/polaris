/**
 * Changing a player's skin, as the server actions do it.
 *
 * Pinned: what is applied is always signed - a profile's own value while the
 * arms match it, the signing service's otherwise; the mod is told in two lines
 * and asked again, so the answer is what the server holds; a server whose mod
 * lacks the command is said to be one, and nothing is sent to it; a file of the
 * wrong size or a busy signing service fails in a sentence, not a throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL = "aaaaaaaa-2222-4222-8222-222222222222";
const HASH = "b".repeat(64);
const SLIM_HASH = "c".repeat(64);

const said: string[] = [];
const audits: { action: string; metadata: unknown }[] = [];
let caps: string[] = ["skin"];
let live: Record<string, unknown> | null = null;
let stageReply: Record<string, unknown> = { ok: true, staged: true };
let containerFailure: Error | null = null;
let linkResponse: Response | null = null;
/** Whether the viewer moderates the server, and which names are linked to them. */
let moderates = true;
let linked: string[] = [];

function packed(hash: string, model: "classic" | "slim"): string {
    const skin = {
        url: `http://textures.minecraft.net/texture/${hash}`,
        ...(model === "slim" ? { metadata: { model: "slim" } } : {})
    };
    return Buffer.from(JSON.stringify({ textures: { SKIN: skin } })).toString("base64");
}

const SIGNATURE = Buffer.from("fixture-signature-bytes-0123456789").toString("base64");

/** A PNG header of the given size: enough for the skin check, which reads no further. */
function png(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(40);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([...Buffer.from("IHDR")], 12);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

const SKIN_PNG = png(64, 64);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

vi.mock("@polaris/app-host", () => ({
    host: {
        auditService: {
            recordAudit: async (entry: { action: string; metadata: unknown }) => {
                audits.push(entry);
            }
        },
        rateLimitService: { rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) },
        appsInstallAccess: {
            requireGameServer: async (permission: string) => {
                if (permission === "games.moderate" && !moderates) throw new Error("Server not found");
                return {
                    user: { id: "user-one" },
                    access: { ownerId: "owner-one", install: { id: INSTALL } }
                };
            }
        },
        safeFetch: {
            safeUrl: async (address: string) => new URL(address),
            follow: async () => linkResponse,
            readCapped: async (response: Response) => new Uint8Array(await response.arrayBuffer())
        }
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerLink: {
            findFirst: async ({ where }: { where: { userId: string; player: { equals: string } } }) =>
                where.userId === "user-one" &&
                linked.some((name) => name.toLowerCase() === where.player.equals.toLowerCase())
                    ? { id: "link-one" }
                    : null
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/screens/game-words", () => ({
    gameWords: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key,
    messageText: async (message: string) => message
}));

let serverId = 0;

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (
        _owner: string,
        _install: string,
        work: (server: unknown) => Promise<unknown>
    ) => {
        if (containerFailure) throw containerFailure;
        return work({
            // A fresh id per call, so the remembered caps never leak between tests.
            installedAppId: `server-${(serverId += 1)}`,
            edition: "java",
            say: async ([line]: string[]) => {
                said.push(line!);
                if (line === "polaris caps")
                    return JSON.stringify({ ok: true, polaris: "1", caps });
                if (line!.startsWith("polaris skin get")) return JSON.stringify(live ?? { ok: true });
                if (line!.startsWith("polaris skin stage")) return JSON.stringify(stageReply);
                if (line!.startsWith("polaris skin apply")) {
                    const hash = line!.includes(SIGNATURE) ? SLIM_HASH : HASH;
                    live = { ok: true, hash, model: "slim", signed: true };
                    return JSON.stringify({ ok: true });
                }
                if (line!.startsWith("polaris skin clear")) {
                    live = { ok: true };
                    return JSON.stringify({ ok: true });
                }
                return JSON.stringify({ ok: true });
            }
        });
    }
}));

const actions = await import("@polaris-app/game-servers/src/screens/installed/skin-actions");

const fetched: { url: string; init?: RequestInit }[] = [];
const signed = () =>
    Response.json({ skin: { texture: { data: { value: packed(SLIM_HASH, "slim"), signature: SIGNATURE } } } });
let signingReply: () => Response = signed;

beforeEach(() => {
    said.length = 0;
    audits.length = 0;
    fetched.length = 0;
    caps = ["skin"];
    live = null;
    stageReply = { ok: true, staged: true };
    containerFailure = null;
    linkResponse = null;
    moderates = true;
    linked = [];
    signingReply = signed;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        fetched.push({ url, init });
        if (url.includes("api.mojang.com/users/profiles/minecraft/player_one"))
            return Response.json({ id: "0123456789abcdef0123456789abcdef", name: "player_one" });
        if (url.includes("api.mojang.com")) return new Response(null, { status: 404 });
        if (url.includes("sessionserver.mojang.com"))
            return Response.json({
                properties: [
                    { name: "textures", value: packed(HASH, "slim"), signature: SIGNATURE }
                ]
            });
        if (url.includes("textures.minecraft.net")) return new Response(SKIN_PNG);
        if (url.includes("api.mineskin.org")) return signingReply();
        return new Response(null, { status: 500 });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("reading a skin", () => {
    it("reports what the mod says the player wears", async () => {
        live = { ok: true, hash: HASH, model: "slim", signed: true };
        const result = await actions.readSkinAction({ installedAppId: INSTALL, player: "player_one" });
        expect(result.live).toEqual({
            state: "read",
            skin: { hash: HASH, model: "slim", signed: true }
        });
        expect(said).toContain("polaris skin get player_one");
    });

    it("says the mod lacks skins and asks it nothing more", async () => {
        caps = ["stash"];
        const result = await actions.readSkinAction({ installedAppId: INSTALL, player: "player_one" });
        expect(result.live).toEqual({ state: "unsupported" });
        expect(said).toEqual(["polaris caps"]);
    });

    it("refuses a name the game would not take", async () => {
        const result = await actions.readSkinAction({ installedAppId: INSTALL, player: "no spaces" });
        expect(result.error).toBe("errors.checkTheDetailsAndTry");
        expect(said).toEqual([]);
    });
});

describe("previewing a source", () => {
    it("takes a username's skin from Mojang, signed, with its own arms", async () => {
        const result = await actions.previewSkinAction({
            installedAppId: INSTALL,
            kind: "text",
            text: "player_one"
        });
        expect(result.error).toBeUndefined();
        expect(result.model).toBe("slim");
        expect(result.signed?.signature).toBe(SIGNATURE);
        expect(result.png).toBe(base64(SKIN_PNG));
        expect(fetched.some((one) => one.url.includes("unsigned=false"))).toBe(true);
    });

    it("says so for a name no account has", async () => {
        const result = await actions.previewSkinAction({
            installedAppId: INSTALL,
            kind: "text",
            text: "nobody_here"
        });
        expect(result.error).toBe("skins.failures.noSuchPlayer");
    });

    it("reads a link through the checked fetch, unsigned until applied", async () => {
        linkResponse = new Response(SKIN_PNG, { headers: { "content-type": "image/png" } });
        const result = await actions.previewSkinAction({
            installedAppId: INSTALL,
            kind: "text",
            text: "https://skins.example.test/one.png"
        });
        expect(result.png).toBe(base64(SKIN_PNG));
        expect(result.signed).toBeNull();
    });

    it("refuses a file that is not a skin's size", async () => {
        const result = await actions.previewSkinAction({
            installedAppId: INSTALL,
            kind: "file",
            png: base64(png(128, 128)),
            fileName: "big.png"
        });
        expect(result.error).toBe("skins.failures.wrongSize");
    });

    it("takes the arms an exported file names", async () => {
        const result = await actions.previewSkinAction({
            installedAppId: INSTALL,
            kind: "file",
            png: base64(SKIN_PNG),
            fileName: "player_one.slim.png"
        });
        expect(result.model).toBe("slim");
    });
});

describe("applying a skin", () => {
    it("uses a profile's signed value as it is while the arms match", async () => {
        const result = await actions.applySkinAction({
            installedAppId: INSTALL,
            player: "player_one",
            png: base64(SKIN_PNG),
            model: "slim",
            signed: { value: packed(HASH, "slim"), signature: SIGNATURE }
        });
        expect(result.error).toBeUndefined();
        expect(fetched.some((one) => one.url.includes("mineskin"))).toBe(false);
        const lines = said.filter((line) => line.startsWith("polaris skin"));
        const token = lines[0]?.split(" ")[4];
        expect(token).toMatch(/^[0-9a-f]{16}$/);
        expect(lines).toEqual([
            `polaris skin stage player_one ${token} ${packed(HASH, "slim")}`,
            `polaris skin apply player_one ${token} ${SIGNATURE}`,
            "polaris skin get player_one"
        ]);
        expect(result.live?.state).toBe("read");
        expect(audits[0]?.action).toBe("minecraft.skin-apply");
    });

    it("signs the PNG first when the arms changed or nothing came signed", async () => {
        const result = await actions.applySkinAction({
            installedAppId: INSTALL,
            player: "player_one",
            png: base64(SKIN_PNG),
            model: "slim",
            signed: null
        });
        expect(result.error).toBeUndefined();
        const signing = fetched.find((one) => one.url.includes("mineskin"));
        const body = JSON.parse(String(signing?.init?.body)) as { url: string; variant: string };
        expect(body.variant).toBe("slim");
        expect(body.url).toBe(`data:image/png;base64,${base64(SKIN_PNG)}`);
        expect(result.live).toEqual({
            state: "read",
            skin: { hash: SLIM_HASH, model: "slim", signed: true }
        });
    });

    it("says how long to wait when the signing service is busy", async () => {
        signingReply = () => new Response("{}", { status: 429, headers: { "retry-after": "12" } });
        const result = await actions.applySkinAction({
            installedAppId: INSTALL,
            player: "player_one",
            png: base64(SKIN_PNG),
            model: "classic",
            signed: null
        });
        expect(result.error).toBe('skins.failures.signingBusyFor {"seconds":12}');
        expect(said.some((line) => line.startsWith("polaris skin stage"))).toBe(false);
    });

    it("sends nothing to a mod without skins and says it needs the update", async () => {
        caps = [];
        const result = await actions.applySkinAction({
            installedAppId: INSTALL,
            player: "player_one",
            png: base64(SKIN_PNG),
            model: "slim",
            signed: { value: packed(HASH, "slim"), signature: SIGNATURE }
        });
        expect(result.error).toBe("skins.needsUpdate");
        expect(said).toEqual(["polaris caps"]);
        expect(audits).toEqual([]);
    });
});

describe("a change the server does not take", () => {
    const apply = () =>
        actions.applySkinAction({
            installedAppId: INSTALL,
            player: "player_one",
            png: base64(SKIN_PNG),
            model: "slim",
            signed: { value: packed(HASH, "slim"), signature: SIGNATURE }
        });

    it("answers with the stage's own refusal and never signs it off", async () => {
        stageReply = { ok: false, why: "offline" };
        const result = await apply();
        expect(result.live).toEqual({ state: "refused", why: "offline" });
        expect(said.some((line) => line.startsWith("polaris skin apply"))).toBe(false);
    });

    it("puts an error that carries no sentence of ours into the fallback", async () => {
        containerFailure = new Error("exec failed: /srv/servers/abc");
        expect((await apply()).error).toBe("skins.couldNotApply");
        expect(
            (await actions.readSkinAction({ installedAppId: INSTALL, player: "player_one" })).error
        ).toBe("skins.couldNotRead");
    });
});

describe("whose skin a player may change", () => {
    const apply = () =>
        actions.applySkinAction({
            installedAppId: INSTALL,
            player: "player_one",
            png: base64(SKIN_PNG),
            model: "slim",
            signed: { value: packed(HASH, "slim"), signature: SIGNATURE }
        });

    it("lets the person a name is linked to change their own", async () => {
        moderates = false;
        linked = ["Player_One"];
        const result = await apply();
        expect(result.error).toBeUndefined();
        expect(audits[0]?.action).toBe("minecraft.skin-apply");
    });

    it("refuses somebody else's to a player who does not moderate", async () => {
        moderates = false;
        linked = ["player_two"];
        const result = await apply();
        expect(result.error).toBe("minecraft:skins.onlyYourOwn");
        expect(said.some((line) => line.startsWith("polaris skin stage"))).toBe(false);
    });

    it("says on the read whether the skin is the viewer's own", async () => {
        linked = ["player_one"];
        const result = await actions.readSkinAction({ installedAppId: INSTALL, player: "player_one" });
        expect(result.ownSkin).toBe(true);
    });
});

describe("clearing a skin", () => {
    it("takes it off and reads back the account's own", async () => {
        live = { ok: true, hash: HASH, model: "classic", signed: true };
        const result = await actions.clearSkinAction({ installedAppId: INSTALL, player: "player_one" });
        expect(said).toContain("polaris skin clear player_one");
        expect(result.live).toEqual({ state: "read", skin: null });
        expect(audits[0]?.action).toBe("minecraft.skin-clear");
    });
});

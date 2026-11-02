// @vitest-environment jsdom
/**
 * The real `public/offline.html`, run on what the real `rememberInstance` stored
 * and against real signatures: the page keeps its own copy of the offer, because
 * no bundle can be counted on while the domain is down, and this is what holds
 * that copy to `lib/local-address.ts` and the catalogs.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import en from "../../messages/en-US/components.json";
import es from "../../messages/es-ES/components.json";
import { generateKeyPairSync, sign } from "node:crypto";
import { isLocalOrigin, rememberInstance } from "@/lib/local-address";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { challengeMessage, isGatewayFailure } from "@polaris/core/instance-fallback";

const HTML = readFileSync(join(__dirname, "../../public/offline.html"), "utf8");
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(HTML)?.[1] ?? "";
const BODY = /<body>([\s\S]*)<script>/.exec(HTML)?.[1] ?? "";
const STYLE = /<style>([\s\S]*)<\/style>/.exec(HTML)?.[1] ?? "";

const ID = "plr_instance-one";
const pair = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const publicKey = String(pair.publicKey.export({ format: "jwk" }).x);
const here = window.location.origin;

type Reply = "signed" | "stranger" | "not-polaris" | "refused" | number;

/** What each address does when challenged; anything unnamed is not there. */
function serve(addresses: string[], replies: Record<string, Reply>) {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        seen.push({ url, init });
        if (url === `${here}/api/instance`) {
            return Response.json({ id: ID, publicKey, addresses });
        }
        const { origin } = new URL(url);
        const reply = replies[origin] ?? "refused";
        if (reply === "refused") throw new TypeError("Failed to fetch");
        if (typeof reply === "number") return new Response(null, { status: reply });
        if (reply === "not-polaris") return new Response("<html></html>");
        const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
        const key = reply === "signed" ? pair.privateKey : stranger.privateKey;
        const message = Buffer.from(challengeMessage(ID, origin, nonce));
        const signature = sign(null, message, key).toString("base64url");
        return Response.json({ id: ID, origin, nonce, signature });
    });
    return seen;
}

/** Stores the record the way a working tab does, then opens the page. */
async function open(addresses: string[], replies: Record<string, Reply>) {
    const seen = serve(addresses, replies);
    await rememberInstance();
    document.body.innerHTML = BODY;
    new Function(SCRIPT)();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return seen;
}

function offered() {
    return document.getElementById("local")?.hidden ? null : document.querySelector("#local a");
}

const kept = new Map<string, string>();

beforeEach(() => {
    kept.clear();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value)
    });
    document.cookie = "polaris-locale=; Max-Age=0; Path=/";
    window.history.replaceState(null, "", "/s/share-token?key=value");
});

afterEach(() => vi.unstubAllGlobals());

describe("the offline page", () => {
    it("stands as it is with nothing remembered", async () => {
        document.body.innerHTML = BODY;
        new Function(SCRIPT)();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(offered()).toBeNull();
    });

    it("carries the address to one that proved it is this Polaris", async () => {
        const origin = "https://polaris.local";
        await open([here, origin], { [origin]: "signed" });
        expect(offered()?.getAttribute("href")).toBe(`${origin}/s/share-token?key=value`);
        expect(offered()?.textContent).toBe(en.network.useLocal);
    });

    it("prefers a proven address, and does not call a public one your network", async () => {
        const origin = "https://other.example.com";
        await open([here, "https://polaris.local", origin], { [origin]: "signed" });
        expect(offered()?.getAttribute("href")).toContain(origin);
        expect(offered()?.textContent).toBe(en.network.useOther);
    });

    it("gives a local address it could not ask only its front door", async () => {
        const origin = "https://192.168.1.2";
        await open([here, origin], {});
        expect(offered()?.getAttribute("href")).toBe(origin);
    });

    it.each<Reply>(["stranger", "not-polaris", 404, 429])(
        "never offers an address that answers as something else: %s",
        async (reply) => {
            const origin = "https://polaris.local";
            await open([here, origin], { [origin]: reply });
            expect(offered()).toBeNull();
        }
    );

    it("never offers a silent public address", async () => {
        await open([here, "https://public.example.com"], {});
        expect(offered()).toBeNull();
    });

    it("never offers the address it is already on, even a local-looking one", async () => {
        const seen = await open([here], {});
        expect(offered()).toBeNull();
        expect(seen.some(({ url }) => url.endsWith("/api/instance/challenge"))).toBe(false);
    });

    it("sends a nonce and nothing else, with no cookie", async () => {
        const origin = "https://polaris.local";
        const seen = await open([here, origin], { [origin]: "signed" });
        const asked = seen.filter(({ url }) => url.startsWith(origin));
        expect(asked.map(({ url }) => url)).toEqual([`${origin}/api/instance/challenge`]);
        expect(asked[0]?.init.credentials).toBe("omit");
        expect(Object.keys(JSON.parse(String(asked[0]?.init.body)))).toEqual(["nonce"]);
    });

    it("draws the same line between local and public as the banner", async () => {
        const origins = [
            "https://polaris.local",
            "https://10.1.2.3",
            "https://192.168.1.2:8443",
            "https://172.16.0.1",
            "https://172.31.0.1",
            "https://172.32.0.1",
            "https://8.8.8.8",
            "https://example.com",
            "https://local.example.com"
        ];
        for (const origin of origins) {
            kept.clear();
            await open([origin], {});
            expect(offered() !== null, origin).toBe(isLocalOrigin(origin));
        }
    });

    it("reads the same statuses as a gateway as the rest of Polaris", async () => {
        const origin = "https://polaris.local";
        for (const status of [500, 502, 503, 504, 519, 520, 530, 531]) {
            kept.clear();
            await open([origin], { [origin]: status });
            expect(offered() !== null, `status ${status}`).toBe(isGatewayFailure(status));
        }
    });

    it("speaks the account's language, in the catalog's words", async () => {
        document.cookie = "polaris-locale=es-ES; Path=/";
        const origin = "https://polaris.local";
        await open([here, origin], { [origin]: "signed" });
        expect(offered()?.textContent).toBe(es.network.useLocal);
        expect(document.querySelector("button")?.textContent).toBe(es.network.retry);
        expect(document.documentElement.lang).toBe("es-ES");
        document.documentElement.lang = "en";
    });

    it("keeps the public label in step with the catalogs", () => {
        expect(SCRIPT).toContain(en.network.useOther);
        expect(SCRIPT).toContain(es.network.useOther);
    });
});

describe("the way out of the page", () => {
    beforeEach(() => {
        const style = document.createElement("style");
        style.textContent = STYLE;
        document.head.append(style);
    });

    afterEach(() => {
        delete (window as { polarisDesktop?: unknown }).polarisDesktop;
        document.head.querySelector("style")?.remove();
    });

    it("links the guide, and offers no servers in a browser", async () => {
        await open([here], {});
        const guide = document.querySelector<HTMLAnchorElement>("#help a");
        expect(guide?.href).toContain("/en/docs/troubleshooting/");
        const button = document.getElementById("servers") as HTMLElement;
        expect(button.hidden).toBe(true);
        expect(getComputedStyle(button).display).toBe("none");
    });

    it("opens the servers window from the desktop app", async () => {
        const openServers = vi.fn();
        (window as { polarisDesktop?: unknown }).polarisDesktop = { openServers };
        await open([here], {});
        const button = document.getElementById("servers") as HTMLElement;
        expect(button.hidden).toBe(false);
        expect(getComputedStyle(button).display).toBe("block");
        button.click();
        expect(openServers).toHaveBeenCalledOnce();
    });

    it("sends a Spanish reader to the Spanish guide", async () => {
        document.cookie = "polaris-locale=es-ES; Path=/";
        await open([here], {});
        const guide = document.querySelector<HTMLAnchorElement>("#help a");
        expect(guide?.href).toContain("/es/docs/troubleshooting/");
        expect(guide?.textContent).toBe("Cómo solucionarlo");
    });
});

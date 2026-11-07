import { describe, expect, it } from "vitest";
import { classifyNavigation, isServerUrl } from "@/main/navigation";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
    activeOrigin,
    backStep,
    failedLoadStep,
    markCertificateFailure,
    samePlaceOn,
    titleWith,
    triggersFailover
} from "@/main/window-failover";
import {
    challengeMessage,
    createFailover,
    USING_LOCAL_WORDS,
    type InstanceRecord
} from "../../../dashboard/packages/core/src/instance-fallback";

const PRIMARY = "https://polaris.example.com";
const LOCAL = "https://polaris.local";
const LAN = "https://192.168.1.20";
const ID = "inst_0123456789abcdef";

function keyPair(): { publicKey: string; privateKey: KeyObject; } {
    const pair = generateKeyPairSync("ed25519");
    return { publicKey: String(pair.publicKey.export({ format: "jwk" }).x), privateKey: pair.privateKey };
}

const real = keyPair();
const impostor = keyPair();
const record: InstanceRecord = { id: ID, publicKey: real.publicKey, addresses: [PRIMARY, LOCAL, LAN] };

type Node = "up" | "down" | "certificate" | { readonly key: KeyObject; };

/** Fake addresses, each up (signing with the real key), down, refusing on its certificate, or signing with another key. */
function network(nodes: Record<string, Node>) {
    const asked: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const parsed = new URL(url);
        asked.push(url);
        const node = nodes[parsed.origin] ?? "down";
        if (node === "down") throw new TypeError("net::ERR_NAME_NOT_RESOLVED");
        if (node === "certificate") throw markCertificateFailure(new TypeError("net::ERR_CERT_AUTHORITY_INVALID"));
        if (parsed.pathname === "/api/instance/challenge") {
            const { nonce } = JSON.parse(String(init.body)) as { nonce: string; };
            const key = node === "up" ? real.privateKey : node.key;
            const signature = sign(null, Buffer.from(challengeMessage(ID, parsed.origin, nonce)), key).toString("base64url");
            return Response.json({ id: ID, nonce, signature });
        }
        return Response.json({ id: ID });
    };
    return { fetchImpl, asked };
}

describe("which failed loads look for the same Polaris elsewhere", () => {
    it("fails over when the address does not answer at all", () => {
        for (const code of ["ERR_NAME_NOT_RESOLVED", "ERR_INTERNET_DISCONNECTED", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_TIMED_OUT", "ERR_ADDRESS_UNREACHABLE"]) {
            expect(triggersFailover(code)).toBe(true);
        }
    });

    it("never fails over on a certificate, an unknown code or no code", () => {
        expect(triggersFailover("ERR_CERT_AUTHORITY_INVALID")).toBe(false);
        expect(triggersFailover("ERR_SSL_PROTOCOL_ERROR")).toBe(false);
        expect(triggersFailover("ERR_BLOCKED_BY_CLIENT")).toBe(false);
        expect(triggersFailover(null)).toBe(false);
    });

    it("ignores a replaced load and a page elsewhere, and reports the rest", () => {
        expect(failedLoadStep(-3, "ERR_ABORTED", `${PRIMARY}/home`, PRIMARY)).toBe("ignore");
        expect(failedLoadStep(-105, "ERR_NAME_NOT_RESOLVED", "https://github.com/login", PRIMARY)).toBe("ignore");
        expect(failedLoadStep(-105, "ERR_NAME_NOT_RESOLVED", `${PRIMARY}/home`, PRIMARY)).toBe("failover");
        expect(failedLoadStep(-202, "ERR_CERT_AUTHORITY_INVALID", `${PRIMARY}/home`, PRIMARY)).toBe("error");
    });

    it("fails over again when the alternate in use stops answering", () => {
        expect(failedLoadStep(-102, "ERR_CONNECTION_REFUSED", `${LOCAL}/tasks`, LOCAL)).toBe("failover");
    });
});

describe("the same place on another address", () => {
    it("keeps the path, query and hash", () => {
        expect(samePlaceOn(`${PRIMARY}/tasks/board?view=list#t-4`, LOCAL)).toBe(`${LOCAL}/tasks/board?view=list#t-4`);
        expect(samePlaceOn(`${LOCAL}/chat`, PRIMARY)).toBe(`${PRIMARY}/chat`);
    });

    it("refuses what is not a web address", () => {
        expect(samePlaceOn("not a url", LOCAL)).toBeNull();
        expect(samePlaceOn("file:///etc/passwd", LOCAL)).toBeNull();
        expect(samePlaceOn(`${PRIMARY}/home`, "javascript:alert(1)")).toBeNull();
    });
});

describe("the origin windows are held to", () => {
    it("is the usual address, or the proven alternate alone while on it", () => {
        expect(activeOrigin(PRIMARY, null)).toBe(PRIMARY);
        expect(activeOrigin(PRIMARY, LOCAL)).toBe(LOCAL);
        expect(activeOrigin(null, LOCAL)).toBeNull();
    });

    it("allows only the proven alternate while on it - not the other learned addresses", () => {
        const origin = activeOrigin(PRIMARY, LOCAL)!;
        expect(isServerUrl(`${LOCAL}/home`, origin)).toBe(true);
        expect(classifyNavigation(`${LAN}/home`, origin)).toBe("external");
        expect(classifyNavigation(`${PRIMARY}/home`, origin)).toBe("external");
        expect(classifyNavigation("http://polaris.local/home", origin)).toBe("external");
        expect(classifyNavigation(`${LOCAL}:8443/home`, origin)).toBe("external");
    });

    it("allows nothing local while on the usual address", () => {
        const origin = activeOrigin(PRIMARY, null)!;
        expect(classifyNavigation(`${LOCAL}/home`, origin)).toBe("external");
        expect(classifyNavigation(`${PRIMARY}/home`, origin)).toBe("allow");
    });
});

describe("going back to the usual address", () => {
    it("waits while the alternate is all that answers", () => {
        expect(backStep(LOCAL, PRIMARY, false)).toBe("stay");
    });

    it("goes at once when the window is not in use, otherwise when it is left", () => {
        expect(backStep(PRIMARY, PRIMARY, false)).toBe("now");
        expect(backStep(PRIMARY, PRIMARY, true)).toBe("on-blur");
    });
});

describe("the quiet sign", () => {
    it("adds the words to the page's title only while on the alternate", () => {
        expect(titleWith("Tasks - Polaris", USING_LOCAL_WORDS)).toBe(`Tasks - Polaris - ${USING_LOCAL_WORDS}`);
        expect(titleWith("  ", USING_LOCAL_WORDS)).toBe(USING_LOCAL_WORDS);
        expect(titleWith("Tasks - Polaris", null)).toBe("Tasks - Polaris");
    });
});

describe("which alternate the window may be moved to", () => {
    it("a local address that signs with the instance key, once the usual one is down", async () => {
        const { fetchImpl } = network({ [PRIMARY]: "down", [LOCAL]: "up" });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        expect(await failover.resolve()).toBe(LOCAL);
        expect(failover.status().words).toBe(USING_LOCAL_WORDS);
    });

    it("never one whose certificate this computer does not trust - it is reported, not used", async () => {
        const { fetchImpl, asked } = network({ [PRIMARY]: "down", [LOCAL]: "certificate", [LAN]: "down" });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        expect(await failover.resolve()).toBe(PRIMARY);
        expect(failover.status().untrusted).toEqual([LOCAL]);
        expect(failover.status().local).toBe(false);
        expect(asked.some((url) => url.startsWith(LOCAL) && !url.endsWith("/api/instance/challenge"))).toBe(false);
    });

    it("never one that signs with another key", async () => {
        const { fetchImpl } = network({ [PRIMARY]: "down", [LOCAL]: { key: impostor.privateKey }, [LAN]: "down" });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        expect(await failover.resolve()).toBe(PRIMARY);
        expect(failover.status().refused).toEqual([LOCAL]);
    });

    it("the usual address again once it answers after the hold", async () => {
        let now = 0;
        const nodes: Record<string, Node> = { [PRIMARY]: "down", [LOCAL]: "up" };
        const { fetchImpl } = network(nodes);
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl, now: () => now, holdMs: 60_000 });
        expect(await failover.resolve()).toBe(LOCAL);
        nodes[PRIMARY] = "up";
        expect(await failover.resolve()).toBe(LOCAL);
        now = 60_001;
        expect(await failover.resolve()).toBe(PRIMARY);
        expect(failover.status().words).toBeNull();
    });
});

describe("a refused certificate from net.fetch", () => {
    it("is marked so the failover reads it as untrusted", () => {
        const caught = markCertificateFailure(new TypeError("net::ERR_CERT_COMMON_NAME_INVALID")) as { code?: string; };
        expect(caught.code).toBe("CERT_UNTRUSTED");
    });

    it("leaves any other failure as it was", () => {
        const caught = markCertificateFailure(new TypeError("net::ERR_NAME_NOT_RESOLVED")) as { code?: string; };
        expect(caught.code).toBeUndefined();
        expect(markCertificateFailure("ERR_CERT_DATE_INVALID")).toBe("ERR_CERT_DATE_INVALID");
    });
});

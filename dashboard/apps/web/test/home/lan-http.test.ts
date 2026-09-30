/**
 * The one way Places speaks HTTP to something on somebody's network.
 *
 * What is worth proving here is the certificate check, because it is the part
 * that fails open silently if it is wrong: a hub whose certificate is pinned has
 * to be refused when a different one answers, and refused before the request -
 * with its key in a header - is written to the socket at all. So these run a real
 * TLS server on the loopback address with throwaway certificates made for this
 * file, and count what reached it.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import * as lan from "@polaris-app/places/src/lib/integrations/lan-http";

// Test-only certificates, generated for this file and used nowhere else. The
// first is its own authority and names itself like a Hue bridge id.
const DEVICE_CERT = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBjTCCATOgAwIBAgIUMbzR53oXndY8gt5hPwSP8lJoaC0wCgYIKoZIzj0EAwIw",
    "GzEZMBcGA1UEAwwQMDAxNzg4ZmZmZTAwMDAwMDAgFw0yNjA5MzAxNzMwNDhaGA8y",
    "MTI2MDkwNjE3MzA0OFowGzEZMBcGA1UEAwwQMDAxNzg4ZmZmZTAwMDAwMDBZMBMG",
    "ByqGSM49AgEGCCqGSM49AwEHA0IABBU1GQk4ZTipCPW4yqdfjGmVGYnwjE6G650L",
    "6umPTQADfix+nix55sVa50lxrZ9/OUsQt5ZTkmyPWsYQg0pHKvijUzBRMB0GA1Ud",
    "DgQWBBS6k2jUP/JW0FHPakCY3eVcqSJZgDAfBgNVHSMEGDAWgBS6k2jUP/JW0FHP",
    "akCY3eVcqSJZgDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQCI",
    "BDgvx4JDsP+vopLztKAIGOXeaIuTpicSB3TTuuNiNgIgfE4XUbUqJ0rmTlAGrFur",
    "c0Cw7bQibMVs8ZnZIP84doQ=",
    "-----END CERTIFICATE-----"
].join("\n");

const DEVICE_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYaLKMw1FiwKMsFtP",
    "kj8n6ChiwgTPBFPlTgsxpVoiHuGhRANCAAQVNRkJOGU4qQj1uMqnX4xplRmJ8IxO",
    "huudC+rpj00AA34sfp4seebFWudJca2ffzlLELeWU5Jsj1rGEINKRyr4",
    "-----END PRIVATE KEY-----"
].join("\n");

const OTHER_CERT = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBhTCCASugAwIBAgIUGoNYNt0fFeneL6Ni6CXuLI//VzowCgYIKoZIzj0EAwIw",
    "FzEVMBMGA1UEAwwMb3RoZXItZGV2aWNlMCAXDTI2MDkzMDE3MzA0OVoYDzIxMjYw",
    "OTA2MTczMDQ5WjAXMRUwEwYDVQQDDAxvdGhlci1kZXZpY2UwWTATBgcqhkjOPQIB",
    "BggqhkjOPQMBBwNCAARob+bp13GJ0omgbq1pT7Vb8j7CvPuhs/sF08LVygYFfJi5",
    "4RN5vLw+rBLdULnk6O7vtMsWsCLV1rkLnVqtxDVRo1MwUTAdBgNVHQ4EFgQUWETO",
    "TJTHYnxCmgQ0K9CdFuMZnv8wHwYDVR0jBBgwFoAUWETOTJTHYnxCmgQ0K9CdFuMZ",
    "nv8wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBIh9S8X+RqjpqR",
    "AvEOERIsvbnthjwBAZ8f4SZ92fdn6wIhAP1OYHpQgGUPSddclKl5/UhFob+36u7D",
    "7uguaOzriFJ6",
    "-----END CERTIFICATE-----"
].join("\n");

const DEVICE_PIN = new X509Certificate(DEVICE_CERT).fingerprint256;

let stop: (() => void) | null = null;
let reached = 0;

afterEach(() => {
    stop?.();
    stop = null;
    reached = 0;
});

async function tlsDevice(): Promise<string> {
    const server = createHttpsServer({ cert: DEVICE_CERT, key: DEVICE_KEY }, (request, response) => {
        reached += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ key: request.headers["x-key"] ?? null }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    stop = () => server.close();
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function plainDevice(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    const server = createHttpServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    stop = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("a pinned certificate", () => {
    it("is taken on trust once, and reported so it can be kept", async () => {
        const origin = await tlsDevice();
        const answer = await lan.lanRequest({ url: `${origin}/`, trust: { pin: null } });
        expect(answer.status).toBe(200);
        expect(answer.certificate?.fingerprint).toBe(lan.normalizeFingerprint(DEVICE_PIN));
    });

    it("lets the same device through afterwards", async () => {
        const origin = await tlsDevice();
        const answer = await lan.lanRequest({
            url: `${origin}/`,
            headers: { "x-key": "secret" },
            trust: { pin: DEVICE_PIN }
        });
        expect(lan.jsonOf(answer)).toEqual({ key: "secret" });
    });

    it("refuses a different certificate before anything is sent to it", async () => {
        const origin = await tlsDevice();
        const other = new X509Certificate(OTHER_CERT).fingerprint256;
        await expect(
            lan.lanRequest({ url: `${origin}/`, headers: { "x-key": "secret" }, trust: { pin: other } })
        ).rejects.toMatchObject({ kind: "unauthorized" });
        expect(reached).toBe(0);
    });
});

describe("a certificate from the maker's authority", () => {
    it("is accepted when it chains to the authority and names the right device", async () => {
        const origin = await tlsDevice();
        const answer = await lan.lanRequest({
            url: `${origin}/`,
            trust: { authority: DEVICE_CERT, name: (name) => name === "001788fffe000000" }
        });
        expect(answer.certificate?.commonName).toBe("001788fffe000000");
    });

    it("is refused when it names another device", async () => {
        const origin = await tlsDevice();
        await expect(
            lan.lanRequest({ url: `${origin}/`, trust: { authority: DEVICE_CERT, name: () => false } })
        ).rejects.toMatchObject({ kind: "unauthorized" });
        expect(reached).toBe(0);
    });

    it("is refused when another authority signed it", async () => {
        const origin = await tlsDevice();
        await expect(
            lan.lanRequest({ url: `${origin}/`, trust: { authority: OTHER_CERT, name: () => true } })
        ).rejects.toMatchObject({ kind: "refused" });
        expect(reached).toBe(0);
    });

    it("will not speak https with no rule for trusting it", async () => {
        const origin = await tlsDevice();
        await expect(lan.lanRequest({ url: `${origin}/` })).rejects.toMatchObject({ kind: "refused" });
    });
});

describe("plain http", () => {
    it("does not follow a redirect off the device", async () => {
        const origin = await plainDevice((_request, response) => {
            response.statusCode = 302;
            response.setHeader("location", "http://169.254.169.254/");
            response.end();
        });
        const answer = await lan.lanRequest({ url: `${origin}/` });
        expect(answer.status).toBe(302);
    });

    it("stops reading an answer far larger than a device sends", async () => {
        const origin = await plainDevice((_request, response) => response.end("x".repeat(5000)));
        await expect(lan.lanRequest({ url: `${origin}/`, maxBytes: 1000 })).rejects.toMatchObject({
            kind: "refused"
        });
    });

    it("says nothing answered when nothing is listening", async () => {
        const origin = await plainDevice((_request, response) => response.end());
        stop?.();
        stop = null;
        await expect(lan.lanRequest({ url: `${origin}/` })).rejects.toMatchObject({ kind: "unreachable" });
    });
});

describe("an address somebody typed", () => {
    it("takes an address, a name, or either with a scheme and a port", () => {
        expect(lan.deviceOrigin("192.168.1.30", "http")).toBe("http://192.168.1.30");
        expect(lan.deviceOrigin("hub.local", "https", 8443)).toBe("https://hub.local:8443");
        expect(lan.deviceOrigin("https://ha.example.test:8123/", "http")).toBe("https://ha.example.test:8123");
        expect(lan.deviceOrigin("homeassistant.local", "http", 8123)).toBe("http://homeassistant.local:8123");
        expect(lan.deviceOrigin("https://ha.example.test", "http", 8123)).toBe("https://ha.example.test");
        expect(lan.deviceHost("https://192.168.1.2:9999")).toBe("192.168.1.2");
    });

    it("refuses anything carrying a path, a query or credentials", () => {
        expect(lan.deviceOrigin("http://192.168.1.30/api", "http")).toBeNull();
        expect(lan.deviceOrigin("http://admin:pw@192.168.1.30", "http")).toBeNull();
        expect(lan.deviceOrigin("192.168.1.30?x=1", "http")).toBeNull();
        expect(lan.deviceOrigin("ftp://192.168.1.30", "http")).toBeNull();
        expect(lan.deviceOrigin("", "http")).toBeNull();
    });
});

/**
 * Which operating system key store the page gets: the desktop app's, the
 * Android app's or the iOS app's bridge, checked for shape, and nothing in a
 * plain browser. A bridge that throws, answers null, "" or junk is a refusal.
 */

import { describe, expect, it } from "vitest";
import { platformKeyWrap } from "../../../src/lib/chat/e2ee/platform-key-wrap";

const PLAIN = new Uint8Array([1, 2, 3, 250]);

describe("platform key wrap", () => {
    it("is null in a plain browser or for a bridge of the wrong shape", () => {
        expect(platformKeyWrap({})).toBeNull();
        expect(platformKeyWrap({ polarisDesktop: { version: "0.1.0" } })).toBeNull();
        expect(platformKeyWrap({ polarisDesktop: { keyWrap: { seal: "x", open: () => null } } })).toBeNull();
        expect(platformKeyWrap({ webkit: { messageHandlers: {} } })).toBeNull();
    });

    it("round-trips through each app's bridge, by name", async () => {
        const echo = { seal: (data: string) => `w${data}`, open: (sealed: string) => sealed.slice(1) };
        const desktop = platformKeyWrap({ polarisDesktop: { keyWrap: echo } })!;
        expect(desktop.name).toBe("desktop-safe-storage");
        const android = platformKeyWrap({ PolarisKeyStore: echo })!;
        expect(android.name).toBe("android-keystore");
        const ios = platformKeyWrap({
            webkit: {
                messageHandlers: {
                    polarisKeyStore: {
                        postMessage: async (message: { op: string; data: string }) =>
                            message.op === "seal" ? `w${message.data}` : message.data.slice(1)
                    }
                }
            }
        })!;
        expect(ios.name).toBe("ios-keychain");
        for (const wrap of [desktop, android, ios]) {
            const sealed = (await wrap.seal(PLAIN))!;
            expect(Array.from((await wrap.open(sealed))!)).toEqual(Array.from(PLAIN));
        }
    });

    it("reads a throw, null, an empty string or junk as a refusal", async () => {
        for (const answer of [null, "", "not base64!", 42, "x".repeat(5000)]) {
            const wrap = platformKeyWrap({ PolarisKeyStore: { seal: () => answer, open: () => answer } })!;
            expect(await wrap.seal(PLAIN)).toBeNull();
            expect(await wrap.open(PLAIN)).toBeNull();
        }
        const fail = async () => {
            throw new Error("no keychain");
        };
        const throwing = platformKeyWrap({ polarisDesktop: { keyWrap: { seal: fail, open: fail } } })!;
        expect(await throwing.seal(PLAIN)).toBeNull();
        expect(await throwing.open(PLAIN)).toBeNull();
    });
});

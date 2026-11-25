/**
 * The sealed-chat flag: off with nothing set until phase 14, and once its
 * default is on, on with nothing set and `0` as the kill switch.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as flag from "@/lib/chat/e2ee/flag";

const before = process.env.POLARIS_INTERNAL_CHAT_E2EE;

afterEach(() => {
    if (before === undefined) delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
    else process.env.POLARIS_INTERNAL_CHAT_E2EE = before;
});

describe("chatE2eeEnabled", () => {
    it("stays off by default until the release that turns it on", () => {
        expect(flag.CHAT_E2EE_DEFAULT_ON).toBe(false);
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(flag.chatE2eeEnabled()).toBe(false);
    });

    it("is on with 1 and off with 0", () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        expect(flag.chatE2eeEnabled()).toBe(true);
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect(flag.chatE2eeEnabled()).toBe(false);
    });
});

describe("chatE2eeFrom, the default-on shape", () => {
    it("is on with nothing set, so an install that never got the key has it", () => {
        expect(flag.chatE2eeFrom(undefined, true)).toBe(true);
        expect(flag.chatE2eeFrom("", true)).toBe(true);
    });

    it("keeps 0 as the kill switch, also with stray spaces", () => {
        expect(flag.chatE2eeFrom("0", true)).toBe(false);
        expect(flag.chatE2eeFrom(" 0\n", true)).toBe(false);
    });

    it("never lets an unknown value flip the default", () => {
        for (const value of ["true", "yes", "on", "off", "false", "2"]) {
            expect(flag.chatE2eeFrom(value, true)).toBe(true);
            expect(flag.chatE2eeFrom(value, false)).toBe(false);
        }
    });
});

describe("chatE2eeState, the kill switch", () => {
    it("holds with 0 rather than switching off, whatever the default", () => {
        expect(flag.chatE2eeStateFrom("0", true)).toBe("held");
        expect(flag.chatE2eeStateFrom(" 0\n", false)).toBe("held");
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect(flag.chatE2eeState()).toBe("held");
        expect(flag.sealedChatServed()).toBe(true);
        expect(flag.chatE2eeEnabled()).toBe(false);
    });

    it("is on with 1 or the default on, and off only when unset with the default off", () => {
        expect(flag.chatE2eeStateFrom("1", false)).toBe("on");
        expect(flag.chatE2eeStateFrom(undefined, true)).toBe("on");
        expect(flag.chatE2eeStateFrom(undefined, false)).toBe("off");
        expect(flag.chatE2eeStateFrom("yes", false)).toBe("off");
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(flag.sealedChatServed()).toBe(false);
    });
});

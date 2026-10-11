/**
 * The form that adds a NAS location: what people paste is taken as they mean it,
 * and what cannot be mounted is refused with a reason the screen can word.
 */

import { describe, expect, it } from "vitest";
import * as input from "@/lib/storage-moves/location-input";

function check(raw: Record<string, unknown>) {
    return input.locationInputSchema.safeParse(input.normalizeLocationInput(raw));
}

function reason(raw: Record<string, unknown>): string | undefined {
    const parsed = check(raw);
    return parsed.success ? undefined : input.locationError(parsed.error.issues[0]?.message);
}

describe("normalizeLocationInput", () => {
    it("keeps only the share from a pasted UNC or URL-style path", () => {
        expect(input.normalizeLocationInput({ protocol: "smb", path: "\\\\nas\\media" }).path).toBe("media");
        expect(input.normalizeLocationInput({ protocol: "smb", path: "//nas/media/" }).path).toBe("media");
        expect(input.normalizeLocationInput({ protocol: "smb", path: " media " }).path).toBe("media");
    });

    it("gives an export its leading slash and trims everything but the password", () => {
        const value = input.normalizeLocationInput({
            name: "  Office NAS ",
            protocol: "nfs",
            host: " nas.local ",
            path: "volume1/data",
            password: " keep spaces "
        });
        expect(value).toMatchObject({ name: "Office NAS", host: "nas.local", path: "/volume1/data", password: " keep spaces " });
    });

    it("drops empty optional fields instead of storing blanks", () => {
        const value = input.normalizeLocationInput({ protocol: "smb", username: "  ", password: "", domain: "" });
        expect(value.username).toBeUndefined();
        expect(value.password).toBeUndefined();
        expect(value.domain).toBeUndefined();
    });
});

describe("locationInputSchema", () => {
    const smb = { name: "NAS", protocol: "smb", host: "192.168.1.20", path: "data", username: "polaris", password: "x" };

    it("accepts an SMB share and an NFS export", () => {
        expect(check(smb).success).toBe(true);
        expect(check({ name: "NAS", protocol: "nfs", host: "nas.local", path: "/volume1/data" }).success).toBe(true);
    });

    it("names what is missing or wrong", () => {
        expect(reason({ ...smb, name: "" })).toBe("nameRequired");
        expect(reason({ ...smb, host: "" })).toBe("hostRequired");
        expect(reason({ ...smb, host: "nas local" })).toBe("hostInvalid");
        expect(reason({ ...smb, path: "data/sub" })).toBe("shareInvalid");
        expect(reason({ name: "NAS", protocol: "nfs", host: "nas", path: "/a/../etc" })).toBe("exportInvalid");
        expect(reason({ ...smb, name: "x".repeat(121) })).toBe("nameTooLong");
    });

    it("refuses control characters anywhere they would reach a mount", () => {
        expect(reason({ ...smb, path: "da\u0007ta" })).toBe("pathInvalid");
        expect(reason({ ...smb, username: "a\nb" })).toBe("pathInvalid");
    });

    it("maps an unknown message to a reason that has words", () => {
        expect(input.locationError("somethingElse")).toBe("pathInvalid");
        expect(input.locationError(undefined)).toBe("pathInvalid");
    });
});

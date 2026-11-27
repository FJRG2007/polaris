/**
 * The SSH review lists the keys that keep signing in, by fingerprint as
 * `ssh-keygen -l` prints it, and names the one Polaris signs in with.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/app-host", () => ({ host: {} }));

const { keyFingerprint, keyViews } = await import(
    "@polaris-app/security-scans/src/lib/ssh-service"
);

const ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
// `ssh-keygen -lf` on the same key.
const FINGERPRINT = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";

describe("SSH key views", () => {
    it("fingerprints a key the way ssh-keygen does", () => {
        expect(keyFingerprint(ED25519)).toBe(FINGERPRINT);
    });

    it("names Polaris's own key and drops a blob that is not the key it claims", () => {
        const views = keyViews(
            [
                { account: "polaris", type: "ssh-ed25519", blob: ED25519, comment: "" },
                { account: "alice", type: "ssh-ed25519", blob: ED25519, comment: "laptop" },
                { account: "eve", type: "ssh-rsa", blob: ED25519, comment: "spoof" }
            ],
            ED25519
        );
        expect(views).toEqual([
            {
                account: "polaris",
                type: "ssh-ed25519",
                comment: "",
                fingerprint: FINGERPRINT,
                polaris: true
            },
            {
                account: "alice",
                type: "ssh-ed25519",
                comment: "laptop",
                fingerprint: FINGERPRINT,
                polaris: true
            }
        ]);
        expect(keyViews([{ account: "a", type: "ssh-ed25519", blob: ED25519, comment: "" }], null))
            .toMatchObject([{ polaris: false }]);
    });
});

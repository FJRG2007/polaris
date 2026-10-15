/**
 * Which source Drive probes for reachability, and where.
 *
 * The answer decides whether a device can be opened at all, so a wrong port is
 * not a missed optimisation: it marks a live NAS as off and locks its files away
 * behind a badge. A port is therefore only ever used when the connection names it
 * or the protocol defines it - never when a vendor's default would have to be
 * guessed - and a source with no machine behind it is not probed at all.
 */

import { describe, expect, it } from "vitest";
import { sourceEndpoint } from "../../src/lib/drive-source-status";

describe("the endpoint a Drive source is probed on", () => {
    it("uses the port the connection names, whatever the kind", () => {
        expect(sourceEndpoint({ kind: "sftp", host: "10.0.0.4", port: 2222 })).toEqual({
            host: "10.0.0.4",
            port: 2222
        });
        expect(sourceEndpoint({ kind: "synology", host: "nas.lan", port: 5001 })).toEqual({
            host: "nas.lan",
            port: 5001
        });
    });

    it("falls back to the port the protocol defines", () => {
        expect(sourceEndpoint({ kind: "sftp", host: "a" })).toEqual({ host: "a", port: 22 });
        expect(sourceEndpoint({ kind: "smb", host: "a" })).toEqual({ host: "a", port: 445 });
        expect(sourceEndpoint({ kind: "nfs", host: "a" })).toEqual({ host: "a", port: 2049 });
    });

    it("reaches a UNAS on its console, which answers while SMB is still off", () => {
        expect(sourceEndpoint({ kind: "unifi-unas", host: "unas.lan" })).toEqual({
            host: "unas.lan",
            port: 443
        });
        expect(sourceEndpoint({ kind: "unifi-unas", host: "unas.lan", secure: false })).toEqual({
            host: "unas.lan",
            port: 80
        });
    });

    it("takes host and port from a WebDAV base URL", () => {
        expect(sourceEndpoint({ kind: "webdav", baseUrl: "https://dav.example.com/remote" })).toEqual({
            host: "dav.example.com",
            port: 443
        });
        expect(sourceEndpoint({ kind: "webdav", baseUrl: "http://dav.lan:8080/x" })).toEqual({
            host: "dav.lan",
            port: 8080
        });
    });

    it("probes nothing when the port would have to be guessed", () => {
        // A DSM or QNAP console is not on a port anything but the device knows.
        expect(sourceEndpoint({ kind: "synology", host: "nas.lan" })).toBeNull();
        expect(sourceEndpoint({ kind: "qnap", host: "nas.lan" })).toBeNull();
    });

    it("probes nothing when there is no machine to reach", () => {
        expect(sourceEndpoint({ kind: "local", root: "/srv" })).toBeNull();
        expect(sourceEndpoint({ kind: "s3", bucket: "backups", region: "eu-west-1" })).toBeNull();
        expect(sourceEndpoint({})).toBeNull();
        expect(sourceEndpoint({ kind: "sftp", host: "   " })).toBeNull();
        expect(sourceEndpoint({ kind: "webdav", baseUrl: "not a url" })).toBeNull();
    });
});

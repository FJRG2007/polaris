import { describe, expect, it, vi } from "vitest";
import type { Client } from "ssh2";
import { openRootSftp, ROOT_SFTP_COMMAND } from "../src/exec";

/** A client whose `sftp()` makes the subsystem request the way ssh2 does. */
function fakeClient() {
    const protocol = { subsystem: vi.fn(), exec: vi.fn() };
    const client = {
        _protocol: protocol,
        sftp(cb: (error: Error | undefined, sftp: unknown) => void) {
            protocol.subsystem(7, "sftp", true);
            cb(undefined, { channel: 7 });
        }
    };
    return { client: client as unknown as Client, protocol };
}

describe("openRootSftp", () => {
    it("asks for the SFTP session as an exec of the sudo sftp-server command", async () => {
        const { client, protocol } = fakeClient();
        const subsystem = protocol.subsystem;
        await openRootSftp(client);
        expect(protocol.exec).toHaveBeenCalledWith(7, ROOT_SFTP_COMMAND, true);
        expect(subsystem).not.toHaveBeenCalled();
    });

    it("leaves any other subsystem request alone", async () => {
        const { client, protocol } = fakeClient();
        const subsystem = protocol.subsystem;
        await openRootSftp(client);
        protocol.subsystem(9, "other", true);
        expect(subsystem).toHaveBeenCalledWith(9, "other", true);
    });

    it("refuses rather than open a login session when the protocol object is not there", async () => {
        await expect(openRootSftp({ sftp: vi.fn() } as unknown as Client)).rejects.toThrow(
            "root_sftp_unsupported"
        );
    });

    it("runs sftp-server through sudo that never prompts", () => {
        expect(ROOT_SFTP_COMMAND.startsWith("sudo -n ")).toBe(true);
    });
});

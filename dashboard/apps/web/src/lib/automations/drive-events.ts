/**
 * A file uploaded to Drive, told to the automations listening for it.
 *
 * Only to automations whose runner may read that file, by the check Drive's
 * own listing makes: the Drive permission, then the folder's access rules and
 * locks.
 */

import { baseName } from "@polaris/core";
import { authorizeDrive } from "@/lib/drive-authz";
import { sessionCan, type SessionUser } from "@/lib/session";
import { emitAppEvent } from "./app-events";

export interface UploadedFile {
    readonly connectionId: string;
    readonly path: string;
    readonly size: bigint | number;
    readonly uploaderId: string;
}

export async function announceUpload(file: UploadedFile): Promise<boolean> {
    return emitAppEvent(
        "drive.file-uploaded",
        {
            connectionId: file.connectionId,
            path: file.path.slice(0, 1024),
            name: baseName(file.path).slice(0, 255),
            size: Number(file.size),
            uploaderId: file.uploaderId
        },
        {
            // The same file uploaded again a minute later is a new upload.
            key: `${file.connectionId}:${file.path}:${Math.floor(Date.now() / 60_000)}`,
            mayReceive: async (runner) => {
                const user: SessionUser = { ...runner, email: "", name: "", sessionId: "" };
                if (!(await sessionCan(user, "drive.read"))) return false;
                // A locked folder stays shut: an automation holds no unlock.
                await authorizeDrive(runner.id, file.connectionId, file.path, "read");
                return true;
            }
        }
    );
}

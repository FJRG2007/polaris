/**
 * @polaris/ssh - the shared SSH primitive. A single authenticated ssh2 client
 * with host-key pinning, used by both @polaris/docker (docker-over-ssh) and
 * @polaris/storage (SFTP), so SSH auth and pinning live in exactly one place.
 */

export {
    openSshClient,
    testAndCaptureHostKey,
    hostKeyAccepted,
    type SshAuth,
    type SshConnectOptions
} from "./client.js";
export {
    execCommand,
    openShell,
    openRootShell,
    openSftp,
    forwardOut,
    clampDim,
    type ExecResult,
    type ExecOptions,
    type ShellOptions
} from "./exec.js";
export { SshPool, type SshLease } from "./pool.js";
export { generateSshKeyPair, publicKeyBlob, type SshKeyPair } from "./keygen.js";

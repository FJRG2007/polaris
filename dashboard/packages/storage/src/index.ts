/**
 * @polaris/storage - the storage-provider abstraction. Import the driver
 * contract, the credential crypto, and the registry from here. Concrete drivers
 * live under ./drivers; new providers are added there and wired into the
 * registry without changing the interface every consumer depends on.
 */

export * from "./driver.js";
export * from "./crypto.js";
export * from "./registry.js";
export { LocalDriver } from "./drivers/local.js";
export {
    SftpDriver,
    type SftpConnectOptions,
    type SftpDriverOptions,
    type SftpSessionOptions
} from "./drivers/sftp.js";
export {
    openSmbSession,
    SmbDriver,
    type SmbConnectOptions,
    type SmbDriverOptions,
    type SmbSession,
    type SmbSessionOptions
} from "./drivers/smb.js";

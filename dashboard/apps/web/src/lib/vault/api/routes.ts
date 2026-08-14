/**
 * Every path the vault answers on, in one list.
 *
 * This is the contract with the Bitwarden clients, and it is meant to be read
 * as one: what is here works, what is not here does not, and a client reporting
 * a missing feature is a line that is absent rather than a folder somebody
 * forgot to make.
 *
 * Several operations appear twice under different verbs or paths. That is not
 * redundancy - clients of different ages call different ones, and leaving out
 * the older spelling breaks the browser extension while the desktop app works.
 */

import * as misc from "@/lib/vault/api/misc";
import * as orgs from "@/lib/vault/api/orgs";
import * as items from "@/lib/vault/api/items";
import * as sends from "@/lib/vault/api/sends";
import * as accounts from "@/lib/vault/api/accounts";
import * as identity from "@/lib/vault/api/identity";
import type { VaultRoute } from "@/lib/vault/api/router";
import * as attachments from "@/lib/vault/api/attachments";

export const VAULT_ROUTES: readonly VaultRoute[] = [
    // ---- identity: reached before there is a token -------------------------
    { method: "POST", path: "identity/accounts/prelogin", auth: "none", handle: identity.prelogin },
    { method: "POST", path: "identity/connect/token", auth: "none", handle: identity.connectToken },
    {
        method: "POST",
        path: "identity/accounts/register",
        auth: "none",
        handle: identity.registerRefusal
    },
    // Some clients ask for prelogin under /api rather than /identity.
    { method: "POST", path: "api/accounts/prelogin", auth: "none", handle: identity.prelogin },

    // ---- what a client asks before it decides what it can do ---------------
    { method: "GET", path: "api/config", auth: "none", handle: misc.config },
    { method: "GET", path: "api/version", auth: "none", handle: misc.version },
    { method: "GET", path: "api/alive", auth: "none", handle: misc.alive },
    { method: "GET", path: "api/now", auth: "none", handle: misc.alive },
    { method: "GET", path: "icons/:domain/icon.png", auth: "none", handle: misc.icon },
    { method: "POST", path: "notifications/hub/negotiate", auth: "none", handle: misc.negotiate },
    { method: "GET", path: "events", auth: "bearer", handle: misc.events },

    // ---- the account -------------------------------------------------------
    { method: "GET", path: "api/sync", auth: "bearer", handle: accounts.getSync },
    { method: "GET", path: "api/accounts/profile", auth: "bearer", handle: accounts.getProfile },
    { method: "PUT", path: "api/accounts/profile", auth: "bearer", handle: accounts.getProfile },
    {
        method: "GET",
        path: "api/accounts/revision-date",
        auth: "bearer",
        handle: accounts.getRevisionDate
    },
    { method: "GET", path: "api/accounts/keys", auth: "bearer", handle: accounts.getKeys },
    { method: "POST", path: "api/accounts/keys", auth: "bearer", handle: accounts.setKeys },
    {
        method: "GET",
        path: "api/users/:id/public-key",
        auth: "bearer",
        handle: accounts.getUserPublicKey
    },
    {
        method: "POST",
        path: "api/accounts/verify-password",
        auth: "bearer",
        handle: accounts.verifyPassword
    },
    {
        method: "POST",
        path: "api/accounts/password",
        auth: "bearer",
        handle: accounts.changePassword
    },
    { method: "POST", path: "api/accounts/kdf", auth: "bearer", handle: accounts.changePassword },
    {
        method: "POST",
        path: "api/accounts/security-stamp",
        auth: "bearer",
        handle: accounts.deauthorize
    },
    { method: "GET", path: "api/two-factor", auth: "bearer", handle: accounts.listTwoFactor },
    { method: "GET", path: "api/settings/domains", auth: "bearer", handle: misc.domains },
    { method: "POST", path: "api/settings/domains", auth: "bearer", handle: misc.domains },

    // ---- devices -----------------------------------------------------------
    // Asked before a client has signed in, so it cannot be a bearer route. Both
    // spellings are live: the extension sends the address in a header, older
    // desktop builds put it in the path.
    {
        method: "GET",
        path: "api/devices/knowndevice",
        auth: "none",
        handle: accounts.knownDevice
    },
    {
        method: "GET",
        path: "api/devices/knowndevice/:email/:identifier",
        auth: "none",
        handle: accounts.knownDevice
    },
    { method: "GET", path: "api/devices", auth: "bearer", handle: accounts.listDevices },
    {
        method: "GET",
        path: "api/devices/identifier/:identifier",
        auth: "bearer",
        handle: accounts.getDeviceByIdentifier
    },
    {
        method: "PUT",
        path: "api/devices/identifier/:identifier/token",
        auth: "bearer",
        handle: accounts.putDeviceToken
    },
    {
        method: "POST",
        path: "api/devices/identifier/:identifier/token",
        auth: "bearer",
        handle: accounts.putDeviceToken
    },
    {
        method: "PUT",
        path: "api/devices/identifier/:identifier/clear-token",
        auth: "bearer",
        handle: accounts.clearDeviceToken
    },
    {
        method: "POST",
        path: "api/devices/identifier/:identifier/clear-token",
        auth: "bearer",
        handle: accounts.clearDeviceToken
    },

    // ---- what a client polls for features Polaris does not run -------------
    { method: "GET", path: "api/tasks", auth: "bearer", handle: misc.emptyList },
    { method: "GET", path: "api/auth-requests", auth: "bearer", handle: misc.emptyList },
    { method: "GET", path: "api/auth-requests/pending", auth: "bearer", handle: misc.emptyList },

    // ---- folders -----------------------------------------------------------
    { method: "GET", path: "api/folders", auth: "bearer", handle: items.listFolders },
    { method: "GET", path: "api/folders/:id", auth: "bearer", handle: items.getFolder },
    { method: "POST", path: "api/folders", auth: "bearer", handle: items.createFolder },
    { method: "PUT", path: "api/folders/:id", auth: "bearer", handle: items.updateFolder },
    { method: "POST", path: "api/folders/:id", auth: "bearer", handle: items.updateFolder },
    { method: "DELETE", path: "api/folders/:id", auth: "bearer", handle: items.deleteFolder },
    { method: "POST", path: "api/folders/:id/delete", auth: "bearer", handle: items.deleteFolder },

    // ---- items -------------------------------------------------------------
    // The table is scanned in order and the first match wins, so every literal
    // third segment has to sit ABOVE `api/ciphers/:id`. Listed the other way
    // round, a bulk delete is read as an edit of an item called "delete" - it
    // matches, fails to parse, and answers 400 for a request that was correct.
    { method: "GET", path: "api/ciphers", auth: "bearer", handle: items.listCiphers },
    { method: "POST", path: "api/ciphers", auth: "bearer", handle: items.createCipher },
    { method: "DELETE", path: "api/ciphers", auth: "bearer", handle: items.destroyCiphers },
    {
        method: "POST",
        path: "api/ciphers/create",
        auth: "bearer",
        handle: items.createCipherInCollections
    },
    {
        method: "GET",
        path: "api/ciphers/organization-details",
        auth: "bearer",
        handle: items.listOrganizationCiphers
    },
    { method: "POST", path: "api/ciphers/import", auth: "bearer", handle: items.importCiphers },
    { method: "PUT", path: "api/ciphers/delete", auth: "bearer", handle: items.trashCiphers },
    { method: "POST", path: "api/ciphers/delete", auth: "bearer", handle: items.destroyCiphers },
    { method: "PUT", path: "api/ciphers/restore", auth: "bearer", handle: items.restoreCiphers },
    { method: "POST", path: "api/ciphers/move", auth: "bearer", handle: items.moveCiphers },
    { method: "PUT", path: "api/ciphers/move", auth: "bearer", handle: items.moveCiphers },
    { method: "POST", path: "api/ciphers/purge", auth: "bearer", handle: items.purge },

    { method: "GET", path: "api/ciphers/:id", auth: "bearer", handle: items.getCipher },
    { method: "GET", path: "api/ciphers/:id/details", auth: "bearer", handle: items.getCipher },
    { method: "PUT", path: "api/ciphers/:id", auth: "bearer", handle: items.updateCipher },
    { method: "POST", path: "api/ciphers/:id", auth: "bearer", handle: items.updateCipher },
    {
        method: "PUT",
        path: "api/ciphers/:id/partial",
        auth: "bearer",
        handle: items.updateCipherPartial
    },
    {
        method: "POST",
        path: "api/ciphers/:id/partial",
        auth: "bearer",
        handle: items.updateCipherPartial
    },
    { method: "PUT", path: "api/ciphers/:id/share", auth: "bearer", handle: items.shareCipher },
    { method: "POST", path: "api/ciphers/:id/share", auth: "bearer", handle: items.shareCipher },
    {
        method: "PUT",
        path: "api/ciphers/:id/collections",
        auth: "bearer",
        handle: items.setCipherCollections
    },
    {
        method: "POST",
        path: "api/ciphers/:id/collections",
        auth: "bearer",
        handle: items.setCipherCollections
    },
    {
        method: "PUT",
        path: "api/ciphers/:id/collections_v2",
        auth: "bearer",
        handle: items.setCipherCollections
    },
    {
        method: "POST",
        path: "api/ciphers/:id/collections_v2",
        auth: "bearer",
        handle: items.setCipherCollections
    },
    { method: "PUT", path: "api/ciphers/:id/delete", auth: "bearer", handle: items.trashCipher },
    { method: "DELETE", path: "api/ciphers/:id", auth: "bearer", handle: items.destroyCipher },
    { method: "POST", path: "api/ciphers/:id/delete", auth: "bearer", handle: items.destroyCipher },
    { method: "PUT", path: "api/ciphers/:id/restore", auth: "bearer", handle: items.restoreCipher },

    // ---- attachments -------------------------------------------------------
    {
        method: "POST",
        path: "api/ciphers/:id/attachment/v2",
        auth: "bearer",
        handle: attachments.beginUpload
    },
    {
        method: "POST",
        path: "api/ciphers/:id/attachment/:attachmentId",
        auth: "bearer",
        handle: attachments.receiveUpload
    },
    {
        method: "GET",
        path: "api/ciphers/:id/attachment/:attachmentId",
        auth: "bearer",
        handle: attachments.download
    },
    {
        method: "DELETE",
        path: "api/ciphers/:id/attachment/:attachmentId",
        auth: "bearer",
        handle: attachments.remove
    },

    // ---- sends -------------------------------------------------------------
    { method: "GET", path: "api/sends", auth: "bearer", handle: sends.listSends },
    { method: "POST", path: "api/sends", auth: "bearer", handle: sends.createSend },
    { method: "GET", path: "api/sends/:id", auth: "bearer", handle: sends.getSend },
    { method: "PUT", path: "api/sends/:id", auth: "bearer", handle: sends.updateSend },
    {
        method: "PUT",
        path: "api/sends/:id/remove-password",
        auth: "bearer",
        handle: sends.removeSendPassword
    },
    { method: "DELETE", path: "api/sends/:id", auth: "bearer", handle: sends.deleteSend },
    { method: "POST", path: "api/sends/access/:id", auth: "none", handle: sends.accessSend },

    // ---- organizations -----------------------------------------------------
    { method: "GET", path: "api/collections", auth: "bearer", handle: orgs.listCollections },
    {
        method: "GET",
        path: "api/organizations/:orgId/collections",
        auth: "bearer",
        handle: orgs.listOrgCollections
    },
    {
        method: "POST",
        path: "api/organizations/:orgId/collections",
        auth: "bearer",
        handle: orgs.createCollection
    },
    {
        method: "PUT",
        path: "api/organizations/:orgId/collections/:id",
        auth: "bearer",
        handle: orgs.updateCollection
    },
    {
        method: "DELETE",
        path: "api/organizations/:orgId/collections/:id",
        auth: "bearer",
        handle: orgs.deleteCollection
    },
    {
        method: "GET",
        path: "api/organizations/:orgId",
        auth: "bearer",
        handle: orgs.getOrganization
    },
    {
        method: "GET",
        path: "api/organizations/:orgId/users",
        auth: "bearer",
        handle: orgs.listMembers
    },
    {
        method: "GET",
        path: "api/organizations/:orgId/keys",
        auth: "bearer",
        handle: orgs.getOrganizationKeys
    },
    {
        method: "GET",
        path: "api/organizations/:orgId/auto-enroll-status",
        auth: "bearer",
        handle: misc.autoEnrollStatus
    }
];

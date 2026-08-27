# Drive - feature roadmap (parity with Nextcloud)

What Nextcloud has that Polaris Drive does not, with an honest size against each.
Intentionally larger than one work session: pick items top-down. Keep it updated
as things land.

**Status:** ✅ done · 🟡 partial · ⬜ todo
**Priority:** P0 (core) · P1 (high) · P2 (nice-to-have)
**Size:** S (an afternoon) · M (a day or two) · L (a week) · XL (weeks, changes other features)

---

## Is Nextcloud the open-source Google Drive?

Yes, and it is the only one of its size. What makes it the reference is not the
file browser - a dozen projects have one - it is that four things arrived
together: a per-account home directory, sharing between accounts on the same
server, sync clients on every platform, and a WebDAV endpoint that third-party
clients speak. Everything else it advertises (versioning, quotas, groupfolders,
federation, online office) hangs off those four.

Its data model is worth copying and is smaller than the feature list suggests:

- **A home per account.** Files live at `data/<uid>/files/`. There is no separate
  "my drive" concept; the home is just a storage whose root is that folder.
- **One share table.** `oc_share` carries a `share_type` that discriminates user
  (0), group (1), public link (3), email (4) and federated (6), a permissions
  bitmask (read 1, update 2, create 4, delete 8, share 16; user shares default to
  31, links to 1), the owner and the initiator kept apart so a re-share is
  attributable, and `file_target` - the name the item is mounted under in the
  recipient's own tree. "Shared with me" is a mount, never a copy.
- **Quota is an account attribute**, and what counts against it is what the
  account *owns*: files shared in from somebody else count against the sharer,
  and versions and the bin do not count at all.
- **External storage is an app**, not the core. That part is what Polaris built
  first, which is why this roadmap is the reverse shape of most ports: Polaris
  started at Nextcloud's edge and is working inwards.

Sources: the `oc_share` schema in `nextcloud/server`, the OCS Share API in the
developer manual, and the quota page in the admin manual.

---

## What Polaris Drive already has

Worth stating, because most of the obvious list is done: storage connections to
local disks, SFTP, SMB, NFS, WebDAV, S3, Synology, QNAP, TrueNAS, UniFi UNAS,
Google Drive, OneDrive and Dropbox; registered servers and running containers
browsed as locations; **a private drive per account**; **sharing an item with a
person or a group, with a role, a note and an expiry, and both directions listed
on one screen**; public links with a password, an expiry, a download cap, an
IP/CIDR allowlist, country and continent rules, and per-link upload, rename,
delete, create-folder, overwrite, download and preview permissions, each with an
access log; drop points that collect files (and text) from people with no
account; snippets; a recycle bin; scheduled deletions; favourites; recent items;
per-item icon, colour, note and hidden flag; password gates on a folder; per-path
access rules for users and groups; a viewer that edits spreadsheets in place and
annotates PDFs, and reads code, Markdown, media, presentations and documents;
zip download of a selection; encrypted archives; folder-weight insights; and
search with wildcards, extensions and regex.

---

## 1. Getting files in and out without a browser

The whole of this section is one gap wearing four faces, and it is the biggest
one between Polaris and Nextcloud. Nothing else on this page matters as much.

| Item                            | Status | Prio | Size | Notes                                                                                                                                                                                                                     |
| ------------------------------- | ------ | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebDAV endpoint**             | ⬜     | P0   | L    | Polaris is a WebDAV *client* and not a *server*. Serving one is what makes every existing client work at once - Finder, Windows Explorer, GNOME Files, rclone, mobile file managers - without writing any of them. Do this first. |
| Desktop sync client             | ⬜     | P1   | XL   | Nextcloud's is a Qt application with years of conflict-resolution behind it. Not worth writing until the endpoint above exists; with it, rclone already covers the technical user.                                          |
| Mobile clients                  | ⬜     | P2   | XL   | Same. The realistic first step is that the dashboard is a good installable web app on a phone, which is a much smaller piece of work.                                                                                       |
| Auto-upload of photos           | ⬜     | P2   | L    | Needs a mobile client, so it is downstream of the row above.                                                                                                                                                               |
| LAN synchronization             | ⬜     | P2   | L    | Nextcloud does not have this either (Resilio and Syncthing do). Listed because the comparison table asks about it.                                                                                                          |

## 2. What a file is, over time

| Item                          | Status | Prio | Size | Notes                                                                                                                                                                                                                                            |
| ----------------------------- | ------ | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File versioning**           | ⬜     | P0   | L    | The one absence that changes how much people trust the thing. Nextcloud keeps versions on write and does not count them against quota. Polaris writes through to the backend, so versions have to live somewhere Polaris chooses - a hidden folder beside the file, or a per-connection store. |
| File locking / check-out      | ⬜     | P1   | M    | Not the same as Polaris's password gates, which are access control. This is "somebody is editing it, do not write over them". Needed the moment two people share an editable folder, which is now possible.                                        |
| Full-text search of contents  | ⬜     | P1   | L    | Polaris searches names. Contents means an index, which means deciding what indexes a NAS full of video without walking it nightly.                                                                                                                |
| Collaborative online office   | ⬜     | P2   | XL   | Collabora or OnlyOffice, both of which are a container and an integration rather than something to write. Polaris already edits spreadsheets and annotates PDFs alone.                                                                            |

## 3. Sharing, past the first version

| Item                              | Status | Prio | Size | Notes                                                                                                                                                                                                                                    |
| --------------------------------- | ------ | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Share with a person or a group    | ✅     | P0   | -    | Roles (can view / can edit), an optional note and an optional expiry, on top of the access rules that were already there.                                                                                                                 |
| Shared with me / shared by me     | ✅     | P0   | -    | `/drive/shared`.                                                                                                                                                                                                                         |
| Re-sharing                        | ⬜     | P1   | M    | Today only the owner of the storage may hand an item out. Nextcloud has a `share` bit in the permission mask; Polaris has `canShare` on `ResourceGrant` already, so the notion exists elsewhere in the codebase and could be reused.        |
| Accepting or declining a share    | ⬜     | P2   | S    | Nextcloud's `accepted` column. Worth it when somebody can be given something they did not ask for; less so on an instance of people who know each other.                                                                                  |
| Mounting a share in your own tree | ⬜     | P2   | M    | Nextcloud's `file_target`: a shared folder appears *inside* your home rather than on a separate screen. This is the part that makes shared items feel like your own files.                                                                |
| Group folders (team drives)       | ⬜     | P1   | L    | A drive owned by a group rather than a person. Polaris has orgs, teams and group grants already, so this is mostly "a personal drive whose owner is a group".                                                                             |
| Note on a public link             | 🟡     | P2   | S    | People shares carry a note; links do not yet.                                                                                                                                                                                            |
| Federation (server to server)     | ⬜     | P2   | XL   | Nextcloud's inter-server sharing. A large protocol for a small number of instances; last.                                                                                                                                                 |
| End-to-end encrypted folders      | ⬜     | P2   | XL   | Polaris already has a zero-knowledge design in Vault and encrypted archives in Drive. A whole E2EE folder is a different thing again and breaks preview, search and the editors.                                                          |

## 4. What the operator controls

| Item                          | Status | Prio | Size | Notes                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------ | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-account quota**         | ⬜     | P1   | M    | Deliberately not in the first version: what a drive can hold is what the disk under it holds, which is the honest answer on somebody's own hardware. It becomes necessary the moment one account can fill the disk a deployment is running from. Nextcloud's rule is the one to copy - what you *own* counts, what was shared with you does not, and the bin and versions do not. Needs a running total, because measuring a whole drive per upload is not affordable over SMB. |
| Where drives are kept         | ✅     | P0   | -    | `/admin/uploads`, beside the other upload destinations. Drives already made stay where their files are.                                                                                                                                                                      |
| Per-account usage, for an admin | ⬜   | P2   | S    | "Who is using the disk". The folder-weight measurement already exists per connection; this is a view over it.                                                                                                                                                                |
| Retention policies            | ⬜     | P2   | M    | Scheduled deletions exist per item. A policy is "everything under here, older than N days".                                                                                                                                                                                  |

## 5. Not worth copying

Stated so nobody re-derives the argument later.

- **A mirrored file index** (Nextcloud's `oc_filecache`). It is what makes quota
  and full-text search cheap, and it is also why a file changed on the disk
  behind Nextcloud's back is invisible until a rescan. Polaris lists live and
  caches measurements with the time they were taken; anything that needs an index
  should say so and build its own, rather than mirroring the tree.
- **A per-file database row for every file.** Same reason. Drive's metadata rows
  exist only for items somebody has actually customised.

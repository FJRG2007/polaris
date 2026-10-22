# Camera privacy

What "privacy mode" is on the cameras Polaris talks to, what Polaris does about
it, and what has and has not been checked against a real camera.

## What privacy means in Polaris

A camera in privacy is one nobody is watching. Two things happen, and the
second happens whatever the camera is:

1. **On the camera**, where its maker gives a way to say so (only Tapo today,
   see below). The camera stops streaming and recording by itself.
2. **In Polaris**, always: the camera's row is marked private and every part of
   Places that reads from a camera leaves it alone - the relay drops its
   stream, recording, the ONVIF event watcher, motion and object detection, the
   still pictures on the wall and the MCP snapshot tool. The tile says
   "Private", not "offline".

So a camera whose maker gives no privacy switch is still private in Polaris:
nothing Polaris runs reads a frame from it. What Polaris cannot do for such a
camera is stop the camera itself - its own app, cloud recording, or anything
else pointed at it keeps working. The screen says which kind each camera is.

Optionally, a camera that pans can be sent to a stored ONVIF preset when it
goes private (pointing at a wall or the ceiling), the same `GotoPreset` the PTZ
pad uses. That is only ever sent by Polaris for cameras without a native
privacy mode.

## Research, per maker

### TP-Link Tapo (native, implemented)

- **Not in ONVIF.** Tapo's ONVIF service (port 2020) has no privacy operation.
  Privacy is in the camera's own local API: HTTPS on port 443, JSON, the same
  API the Tapo app uses on the LAN.
- **The call.** `multipleRequest` wrapping `setLensMaskConfig` with
  `{"lens_mask": {"lens_mask_info": {"enabled": "on" | "off"}}}`; read back with
  `getLensMaskConfig` and `{"lens_mask": {"name": ["lens_mask_info"]}}`. Source:
  pytapo `setPrivacyMode` / `getPrivacyMode`
  (https://github.com/JurajNyiri/pytapo/blob/main/pytapo/__init__.py), which the
  Home Assistant integration uses for its privacy switch
  (https://github.com/JurajNyiri/HomeAssistant-Tapo-Control).
- **Sign-in, three generations**, as pytapo implements them
  (`pytapo/transport/pytapo/pytapo.py`, `pytapo/transport/tpap/tpap.py`):
  1. *Old firmware*: `login` with `{"hashed": true, "password": MD5(pw) upper
     hex, "username": user}` answers a `stok`; requests go in clear to
     `https://<ip>/stok=<stok>/ds`.
  2. *Secure firmware ("encrypt_type 3")*: a `login` carrying only `username`,
     `cnonce` and `encrypt_type: "3"` answers `-40413` with the camera's
     `nonce` and a `device_confirm` = `SHA256(cnonce + H(pw) + nonce) + nonce +
     cnonce`, where `H` is SHA-256 or MD5 upper hex; matching it proves the
     camera knows the password and tells which hash it uses. The second `login`
     sends `digest_passwd` = `SHA256(H(pw) + cnonce + nonce) + cnonce + nonce`
     and answers `stok`, `start_seq` and `user_group`. Requests are wrapped in
     `securePassthrough`: AES-128-CBC/PKCS7 with key `lsk` and IV `ivb`, each the
     first 16 bytes of `SHA256(label + cnonce + nonce + SHA256(cnonce + H(pw) +
     nonce))`; headers `Seq` (incremented per request) and `Tapo_tag` =
     `SHA256(SHA256(H(pw) + cnonce) + body + seq)`.
  3. *Newest firmware ("TPAP")*: answers the encrypt_type 3 login with
     `-40211` and advertises `{"tpap": {"pake": [2]}}` in `login` /
     `sub_method: discover`. It uses a SPAKE2+ (P-256) login and an AES-CCM
     channel (write-up: https://github.com/freeKC/tapo-v4-protocol). pytapo
     notes a C200 on firmware 1.4.6 using it.
- **Which password.** Encrypted control is only accepted for `user_group:
  "root"`, which is the user `admin` with the **TP-Link (Tapo app) account
  password**. The camera account made in the app for RTSP signs in as a third
  party account and is refused for control (pytapo raises on `user_group !=
  "root"`, see HomeAssistant-Tapo-Control issue #456). Polaris therefore uses
  the account password Places already stores for the "Tapo app password"
  connection (`tapo-cloud`), on this camera or another one in the house, and
  only falls back to the camera account on old firmware that accepts it.
- **Lockout.** Failed logins count towards a temporary lockout (`sec_left`
  in the answer). Polaris makes at most one login per attempt and says how long
  to wait when the camera reports one.
- **The "dead angle".** TP-Link's FAQ documents that models with a physical
  privacy button (C125, C225) lower a shield or rotate the lens away, and that
  Privacy Mode from the app stops streaming and recording on every listed model
  (C200 included) (https://www.tp-link.com/support/faq/2791/). Whether a C200 or
  C210 also turns its lens away is not documented there; either way it is the
  firmware that moves. Polaris never sends a PTZ command to a Tapo camera for
  privacy.
- **Certificate.** The camera's HTTPS certificate is self-signed. Polaris pins
  it on the first successful privacy call (SHA-256 fingerprint stored on the
  camera row) and refuses a different one after; the encrypt_type 3 handshake
  also proves the camera knows the password before any command is sent.

**Implemented:** generations 1 and 2. **Not implemented:** generation 3
(TPAP / SPAKE2+). A camera on that firmware is detected from its answer and the
screen says Polaris cannot switch it yet; it still goes private in Polaris.

### ONVIF, generic (fallback, implemented)

ONVIF Profile S/T define no privacy operation. Polaris' fallback is the
Polaris-side privacy above, plus the optional preset.

### Reolink, Hikvision, Dahua, Ezviz, Imou (fallback only)

- Reolink's HTTP API (`/cgi-bin/api.cgi`, `Login` then commands) lists privacy
  masks (`GetMask`/`SetMask`) but no official schema could be found; community
  threads report masks the API could not remove
  (https://community.reolink.com/topic/14678/api-setmask).
- Hikvision privacy masks are documented as GUI steps and as an ISAPI area of
  the device tree, but the exact endpoint schema is only in Hikvision's gated
  ISAPI wiki.
- Dahua masks are areas drawn on the picture, not a mode.
- Ezviz and Imou "sleep" / "privacy" modes are switched through their clouds.

None of these could be grounded in a public, authoritative document, so none
is claimed. They get the Polaris-side privacy and the optional preset.

## Groups

Privacy can be set for one camera, every camera in a zone of a place, or every
camera in a place. Each camera is switched on its own and the answer lists the
ones that failed and why; the others stay switched. Cameras have no room link
(rooms hold devices), so "room" is not a target; a zone is the camera's room.

## Who may switch it

`home.control`, the same as pointing a camera. Somebody a camera was lent to
sees whether it is private but cannot switch it, on the screen, on a deck key
and through the MCP tool alike.

## Stream Deck and Companion

The **Camera privacy** key (`places.camera-privacy`) toggles a camera, a zone or
a place, and shows whether it is private (all private: on; some: a count).
It is bound to the `places_camera_privacy` MCP tool, so the deck reaches
exactly what its owner does.

## Untested on real hardware

Nothing here has been run against a camera from the development machine. The
Tapo request building and handshake are checked against values computed with
pytapo's own formulas (`test/home/tapo-privacy.test.ts`); the TLS pin, the
camera's real answers, and the lens movement have not been observed.

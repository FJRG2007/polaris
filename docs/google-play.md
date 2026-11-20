# Publishing the Android app on Google Play

What the Play Console asks for, answered for this app. The build side is already
automated: every `versionCode` bump on `main` builds a signed
`polaris-android.aab`, and `.github/workflows/mobile.yml` uploads it to Play once
the `PLAY_SERVICE_ACCOUNT_JSON` secret exists. The "Get the apps" page offers the
Play listing by itself once Play answers for `app.polaris.mobile`.

## Order

1. Developer account: identity verified and approved by Google, then the two
   phone numbers (Play only unlocks phone verification after the identity
   documents are approved).
2. Create the app: name "Polaris", App, Free. Keep Play App Signing on; the key
   CI signs with becomes the upload key.
3. Fill the forms below, then the store listing.
4. Upload `polaris-android.aab` from the latest `android-v*` GitHub release by
   hand to Testing -> Internal testing. The Play API refuses an app that has
   never had a release, so the first one is manual.
5. Service account: Google Cloud -> IAM -> Service accounts -> create, add a JSON
   key. Play Console -> Users and permissions -> invite its email with release
   rights. GitHub -> Settings -> Secrets -> Actions -> `PLAY_SERVICE_ACCOUNT_JSON`
   = the JSON. From then on CI uploads every version as an internal draft.
6. A personal developer account must run a closed test with at least 12 testers
   for 14 days before production. An organization account does not.
7. Production: GitHub -> Settings -> Variables -> `PLAY_TRACK` = `production`,
   `PLAY_STATUS` = `completed`.

## Store listing

Title, short and full description in English and Spanish are in
`mobile/android/fastlane/metadata/android/{en-US,es-ES}/`, the 512x512 icon and the
1024x500 feature graphic in `en-US/images/`. Still needed:
at least two phone screenshots.

## App access

Polaris has no content of its own: the user connects it to their own server. The
reviewers need one to sign in to. Give them, under "All or some functionality is
restricted" in the Play Console (the real values go there only, never in this
repository):

> Polaris is a client for a self-hosted Polaris server. Open the app, enter the
> server address below, and sign in with this account.
> Server: `<demo server address>`
> Email: `<demo account email>`
> Password: `<demo account password>`

## Ads

No.

## Content rating

Category: Communication / social. The app lets users exchange messages, media,
voice and video calls with people on the same server, so answer yes to "users can
interact or exchange content" and "shares user location: no". No violence, sexual
content, gambling or drugs in the app itself.

## Target audience

18 and over. The app is not designed for children.

## Data safety

The app sends data only to the Polaris server the user typed in, which they or
their organization run. Nothing goes to the developer or to a third party: no
analytics, no ads, no crash reporter, no Firebase. The only other request is a
GitHub release check, and only in a copy not installed from a store.

Google counts anything that leaves the device as "collected", even to a server
the user chose, so declare it:

| Data type | Collected | Shared | Purpose | Optional |
|---|---|---|---|---|
| Name, email address, user IDs | Yes | No | App functionality, account management | No |
| Messages (in-app messages) | Yes | No | App functionality | No |
| Photos and videos | Yes | No | App functionality | Yes |
| Audio (voice messages, calls) | Yes | No | App functionality | Yes |
| Files and docs | Yes | No | App functionality | Yes |
| Contacts | No | | | |
| Location | No | | | |
| App activity, diagnostics | No | | | |

- Encrypted in transit: answer **No**. The app also connects over plain HTTP to a
  server on the user's own network (`usesCleartextTraffic`), so not every
  connection is encrypted.
- Users can request deletion: yes, from their account on their server.

## Permission and foreground service declarations

- `FOREGROUND_SERVICE_REMOTE_MESSAGING` (foreground service declaration):
  > The app has no push provider (no Firebase), so a foreground service keeps the
  > connection to the user's own Polaris server open to deliver incoming
  > messages, calls and sign-in approvals in real time. It shows a persistent
  > "Connected" notification, which the user can hide from the phone's
  > notification settings.

  Attach a short screen recording: the notification appearing, then a message
  arriving while the app is in the background.
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`:
  > Real-time messaging and calls without Firebase Cloud Messaging: the user's
  > server is self-hosted and cannot send through FCM, so the connection must
  > survive Doze to deliver messages and incoming calls.
- `CAMERA`, `RECORD_AUDIO`: photos, videos and voice messages in chat, and calls.

## Privacy policy

Published at https://fjrg2007.github.io/polaris/en/docs/privacy/ (source: `docs/privacy.md`,
Spanish `docs/privacy.es.md`); that is the URL the Play Console asks for.

Play needs a public URL. The policy has to name who publishes the app and how to
contact them. Those details are filled in where the policy is hosted and in the
Play Console, never in this repository:

> **Polaris for Android - Privacy policy**
>
> Published by `<publisher name>`, contact `<contact email>`.
>
> Polaris for Android is a client for a Polaris server chosen by the user. The
> app sends the data the user enters or shares (account details, messages,
> photos, videos, audio and files) only to that server, which is operated by the
> user or their organization, and whose operator is responsible for it. The
> publisher of the app receives none of it.
>
> The app contains no advertising, analytics or third-party tracking. Copies not
> installed from a store check GitHub for a newer version; that request carries
> no personal data.
>
> Camera and microphone are used only when the user takes a photo or video,
> records a voice message, or joins a call. Data on the server is deleted from
> the user's account there.

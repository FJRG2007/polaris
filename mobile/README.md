# Polaris for phones

Polaris in an app of its own on Android (and, next, iOS): the instance you point it at, signed in like a browser
and kept signed in. The page is the instance's, so the app always shows the version your server runs. The app adds
what a browser tab cannot: the camera and microphone for calls, picking and saving files, the back button, links
to other sites opening in the browser, and a check for newer builds of itself.

## Install on Android

1. Open the newest `android-v*` release on GitHub from the phone and download `polaris-android.apk`.
2. Open the file. Android asks once to allow installs from the browser you downloaded with.
3. Type the address you open Polaris at. The app checks that it is a Polaris before it keeps it.

Later versions install over this one; the app offers them itself, at most twice a day. Hold the app icon and pick
**Use another Polaris** to point it somewhere else.

## Build

`mobile/android` is a plain Java Android project, built and tested in CI (`.github/workflows/mobile.yml`). A
release is published when `versionName` in `app/build.gradle` changes on `main`; bump `versionCode` with it.

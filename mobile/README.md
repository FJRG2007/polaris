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

## Install on iPhone from a Mac

Until the app is on TestFlight, a Mac with Xcode installs it on your own iPhone with a free Apple ID:

1. Install Xcode from the App Store, and XcodeGen (`brew install xcodegen`).
2. In this repository: `cd mobile/ios && xcodegen generate && open Polaris.xcodeproj`.
3. In Xcode, select the Polaris target, open **Signing & Capabilities** and pick your Apple ID as the **Team**. If
   the bundle identifier is taken, change it to one of your own (for example `app.polaris.mobile.yourname`).
4. Connect the iPhone by cable and turn on **Developer Mode** (Settings > Privacy & Security).
5. Choose the iPhone as the run destination and press **Run**.
6. The first time, trust your developer profile on the iPhone: Settings > General > VPN & Device Management.

A free Apple ID signs the app for 7 days; press Run again to renew it. A paid Apple Developer account removes that
limit and allows TestFlight.

## Build

`mobile/android` is a plain Java Android project and `mobile/ios` a Swift one generated from `project.yml`; both
are built in CI (`.github/workflows/mobile.yml`). An Android release is published when `versionName` in
`android/app/build.gradle` changes on `main`; bump `versionCode` with it.

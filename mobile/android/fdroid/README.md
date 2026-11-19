# F-Droid

`app.polaris.mobile.yml` is the build recipe for F-Droid's main repository. To submit it, open a merge request
on [fdroiddata](https://gitlab.com/fdroid/fdroiddata) adding it as `metadata/app.polaris.mobile.yml`, after the
`android-v0.1.4` tag exists. F-Droid then builds every later `android-v*` tag on its own.

F-Droid signs what it builds with its own key, so its copy cannot install over the APK from GitHub or the one
from Google Play, nor the other way round. Adding `Binaries:` and `AllowedAPKSigningKeys:` (the SHA-256 of the
release signing certificate) to the recipe makes F-Droid ship the APK published on GitHub instead, once its own
build of the same tag matches it byte for byte.

The listing text lives in `../fastlane/metadata/android/<locale>/`; a new version needs
`changelogs/<versionCode>.txt` in each language.

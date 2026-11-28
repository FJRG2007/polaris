# How the launcher knows a program is a game

One list of installed game folders feeds both the launcher (a row is a Game or
an Application) and the game watcher (what the Hercules plugin's Games knob and
Game Mode follow). A program is a game when it, the file it starts or the folder
it lists lies inside one of those folders, whichever source listed it (Start menu
shortcut, uninstall entry, store). Nothing is classified by a list of names.

Sources, read-only, bounded in size and count, once per listing off the UI
thread, kept in the listing cache (`launcher-index.json`, `INDEX_VERSION`):

| Store | Where it keeps installed games | Code |
|---|---|---|
| Steam | `libraryfolders.vdf`, `steamapps/appmanifest_*.acf` | `steamGames` |
| Epic | `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` | `epicGames` |
| GOG | uninstall entries `<id>_is1` + `goggame-<id>.info` | `gogGames` |
| Ubisoft Connect | `HKLM\SOFTWARE\(WOW6432Node\)Ubisoft\Launcher\Installs\<id>` `InstallDir` | `ubisoftGames` |
| Rockstar | `HKLM\SOFTWARE\WOW6432Node\Rockstar Games\<title>` `InstallFolder` (+ `InstallFolderSteam`/`Epic`) | `rockstarFolders` |
| EA app / Origin | `HKLM\SOFTWARE\WOW6432Node\EA Games\<title>` `Install Dir`; `%ProgramData%\Origin\LocalContent\*\*.mfst` `dipinstallpath` | `eaFolders`, `originFolders` |
| Battle.net | uninstall entries published by Blizzard Entertainment, `InstallLocation` | `battleNetFolders` |
| Xbox / Microsoft Store | `<drive>:\XboxGames\<title>\Content\MicrosoftGame.config`; a package folder holding `MicrosoftGame.config` | `xboxFolders`, `packagedApps` |
| Windows | `HKCU\System\GameConfigStore\Children\*` `MatchedExeFullPath` (Game Bar's match) | `gameConfigFolders` |

## Verification status per source

Checked read-only on the owner's gaming PC (names and value names only; fixtures
in the repo are synthetic), 2026-11-28. No web lookup was possible in this
session, so nothing below is "sourced doc" yet.

| Source | Status |
|---|---|
| Steam `libraryfolders.vdf` | file present on the PC; format as Playnite reads it; not parsed against the real file in this pass |
| Epic `Manifests\*.item` | verified: folder exists with `.item` files (and a `Pending` folder) |
| Rockstar `WOW6432Node\Rockstar Games\<title>` | verified: `InstallFolder` and `Version` values; the title key is a short id (`GTAV Enhanced`), its folder is `Program Files\Rockstar Games\<name>`; `Launcher` and `Rockstar Games Social Club` keys sit beside it (both skipped) |
| EA app | corrected: no `EA Games` registry key exists on this PC. Installed titles are folders in `%ProgramData%\EA Desktop\InstallData` and the game is in `<library>\EA Games\<title>`, found by `eaAppFolders`. The registry `EA Games` and Origin `.mfst` readers are kept for older installs and are unverified |
| Battle.net uninstall entries (Blizzard) | unverified: none installed on this PC (`ProgramData\Battle.net` is empty) |
| Xbox `XboxGames\<title>\Content\MicrosoftGame.config` | partly verified: `C:\XboxGames` exists with title folders (Minecraft); the `MicrosoftGame.config` file was not looked for |
| Windows Game Bar `GameConfigStore\Children` | not confirmed: the children here hold `Type`, `Revision`, `Flags`, `Parent`, `GameDVR_GameGUID`, `TitleId` and no `MatchedExeFullPath`, so that reader finds nothing on this PC; it stays as an extra hint only |
| GOG, Ubisoft | unverified: not installed here |

Steam, Epic, GOG and Ubisoft follow the Playnite library plugins
(github.com/JosefNemec/PlayniteExtensions).

Stores without a vetted launch link (Rockstar, EA, Battle.net, Game Bar) are read
for folders only: the Start menu shortcut or uninstall entry that already opens
the game becomes a Game through its folder. The user's "Treat as Application"
still wins.

## Sources checked on the web (2026-11-28)

| Source | Status | Reference |
|---|---|---|
| Steam `libraryfolders.vdf`, `appmanifest_*.acf` (`AppState`: `appid`, `name`, `installdir`, `StateFlags`; `installdir` is a folder name under `<library>\steamapps\common`) | sourced doc | docs.rs `steamlocate`, `game-scanner` (`steam/acf.rs`), `game-detector` |
| Origin `%ProgramData%\Origin\LocalContent\<title>\*.mfst`, URL-encoded `dipinstallpath` | sourced doc (community write-up); not on this PC | modding.wiki "game detection" (Vortex developer docs) |
| Xbox `MicrosoftGame.config` sits in the root of a GDK game's content | sourced doc | learn.microsoft.com GDK "MicrosoftGame.config overview" and packaging guide; the `XboxGames\<title>\Content` layout is only seen on this PC, not documented there |
| GOG | sourced doc: GOG's installers and Galaxy write `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>` (`gameID`, `gameName`, path). The reader uses the `_is1` uninstall entries and `goggame-<id>.info` instead; the `GOG.com\Games` key is a possible second source, not yet read | GameFinder wiki "GOG Galaxy"; gog.com forum "querying install path" |
| EA app | the EA app's own data is encrypted (GameFinder's EA Desktop handler decrypts it), which is why `InstallData` folders plus the `EA Games\<title>` folder are used; verified here, no doc found | github.com/erri120/GameFinder |
| Battle.net, Ubisoft Connect, Rockstar registry keys, Game Bar `GameConfigStore` | no documentation found by search; Rockstar verified on a real install, the rest unverified | - |

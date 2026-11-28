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

Steam, Epic, GOG and Ubisoft follow the Playnite library plugins
(github.com/JosefNemec/PlayniteExtensions). The Rockstar, EA, Battle.net, Xbox
and Game Bar locations are the ones those launchers and Windows document or are
known to write; they were written from that knowledge and checked against
fixtures only, not against a live install of each launcher.

Stores without a vetted launch link (Rockstar, EA, Battle.net, Game Bar) are read
for folders only: the Start menu shortcut or uninstall entry that already opens
the game becomes a Game through its folder. The user's "Treat as Application"
still wins.

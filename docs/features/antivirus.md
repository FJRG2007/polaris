# When an antivirus blocks Polaris

[Leer en español](antivirus.es.md) - [Back to the README](../../README.md)

Some antivirus programs stop the Polaris desktop app, its updates, or the page of your
Polaris in the browser. Builds of the desktop app that are not code-signed are the usual
trigger: the antivirus does not know the file yet, so it treats it as suspicious. Add an
exclusion only for what is listed here, and only for a copy of Polaris you downloaded from
your own Polaris or from its official releases.

## Signs that it is the antivirus

- The desktop app does not open, or closes right after it opens.
- An update downloads and then the app stays on the old version.
- The antivirus shows a notification or lists a Polaris file in its quarantine.

## What to exclude

| What | Where (Windows) | Why |
|---|---|---|
| The desktop app's folder | `%LOCALAPPDATA%\polaris` | It holds `polaris.exe`, the updater and one `app-<version>` folder per version, so excluding the folder covers every update after it. |
| Your Polaris address | the address you open Polaris at, for example `polaris.example.com` | Only if the antivirus's web protection blocks the page in the browser. |

To paste the folder, type `%LOCALAPPDATA%\polaris` in the address bar of File Explorer, press
Enter, and copy the full path it opens.

If the antivirus already quarantined a Polaris file, restore it from the quarantine first and
choose the option to stop detecting it, when the antivirus offers one.

## How to do it in each antivirus

Each vendor keeps its own steps up to date; menus change between versions, so follow the
vendor's page for the version you have.

| Antivirus | Where the setting is | Official steps |
|---|---|---|
| Microsoft Defender (Windows Security) | Virus & threat protection settings > Add or remove exclusions > Add an exclusion > Folder | [Microsoft](https://support.microsoft.com/en-us/windows/add-an-exclusion-to-windows-security-811816c0-4dfd-af4a-47e4-c301afe13b26) |
| Malwarebytes | Detection History > Allow List > Add, then the folder (or a website) | [Malwarebytes](https://help.malwarebytes.com/hc/en-us/articles/31589453538075-Add-or-remove-items-from-Malwarebytes-Allow-list) |
| Avast | Menu > Settings > General > Exceptions | [Avast](https://support.avast.com/en-us/article/Antivirus-scan-exclusions) |
| AVG | on the vendor's page | [AVG](https://support.avg.com/SupportArticleView?l=en&urlname=AVG-Antivirus-scan-exclusions) |
| Bitdefender | on the vendor's page | [Bitdefender](https://www.bitdefender.com/consumer/support/answer/13427/) |
| ESET | on the vendor's page | [ESET](https://support.eset.com/en/kb2769-exclude-files-or-folders-from-scanning-in-eset-windows-home-products) |
| Kaspersky | on the vendor's page | [Kaspersky](https://support.kaspersky.com/13971) |
| McAfee | on the vendor's page | [McAfee](https://www.mcafee.com/support/s/article/000001661?language=en_US) |
| Norton | on the vendor's page | [Norton](https://support.norton.com/sp/en/ca/home/current/solutions/v3672136) |

Most of them ask for administrator rights to change exclusions.

## If it still does not open

Remove the exclusion again if it did not help, so the antivirus keeps checking that folder.
Then see [What to check](troubleshooting.md) when a screen says Polaris is not reachable.

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

Menus move between versions. If a step does not match your screen, follow the vendor's page
linked under each one. Most of them ask for administrator rights to change exclusions.

### Microsoft Defender (Windows Security)

1. Open **Windows Security** and select **Virus & threat protection**.
2. Under **Virus & threat protection settings**, select **Manage settings**.
3. Under **Exclusions**, select **Add or remove exclusions**.
4. Select **Add an exclusion** > **Folder**.
5. Choose `%LOCALAPPDATA%\polaris`.

[Microsoft's steps](https://support.microsoft.com/en-us/windows/add-an-exclusion-to-windows-security-811816c0-4dfd-af4a-47e4-c301afe13b26)

### Malwarebytes

1. Open Malwarebytes and select **Detection History**.
2. Open the **Allow List** tab and select **Add**.
3. Select **Allow a file or folder**.
4. Choose `%LOCALAPPDATA%\polaris`.

To allow your Polaris address instead, choose **Allow a website** in step 3.

[Malwarebytes' steps](https://help.malwarebytes.com/hc/en-us/articles/31589453538075-Add-or-remove-items-from-Malwarebytes-Allow-list)

### Avast and AVG

1. Open the antivirus and go to **Menu** > **Settings**.
2. Select **General** > **Exceptions**, then **Add exception**.
3. Select **Next**, then **I understand risks**.
4. Open the **File/Folder** tab.
5. Select the folder icon, choose `%LOCALAPPDATA%\polaris` and select **OK**.
6. Select **Add**.

[Avast's steps](https://support.avast.com/en-us/article/antivirus-scan-exclusions) - [AVG's steps](https://support.avg.com/SupportArticleView?l=en&urlname=AVG-Antivirus-scan-exclusions)

### Norton

1. Open Norton and select **Security** on the left.
2. On the **Scans** tile, select **Open**.
3. Open the **Exclusions** tab and select **Add Exclusion**.
4. Select the browse icon, choose `%LOCALAPPDATA%\polaris` and select **OK**.
5. Select **Add**.

[Norton's steps](https://support.norton.com/sp/en/ca/home/current/solutions/v3672136)

### Kaspersky

1. Open Kaspersky and select the settings (gear) button at the bottom of the main window.
2. Go to **Security settings** > **Threats and exclusions**.
3. Select **Manage exclusions**, then **Add**.
4. Select **Browse**, choose `%LOCALAPPDATA%\polaris` and select **Select**.
5. Leave the status on **Active** and select **Add**.

[Kaspersky's steps](https://support.kaspersky.com/help/Kaspersky/Win21.5/en-US/227390.htm)

### Bitdefender

1. Open Bitdefender and select **Protection**.
2. In the **Antivirus** pane, select **Open**.
3. Open the **Settings** tab and select **Manage Exceptions**.
4. Select **Add an Exception**.
5. Type `%LOCALAPPDATA%\polaris`, or select the magnifying glass to choose it.
6. Turn on the switch next to **Antivirus** and select **Save**.

[Bitdefender's steps](https://www.bitdefender.com/consumer/support/answer/13427/)

### ESET

1. Open ESET and press **F5** for **Advanced setup**.
2. Go to **Scans** and select **Edit** next to **Performance Exclusions**.
3. Select **Add**, then the three dots next to **Path**.
4. Choose `%LOCALAPPDATA%\polaris` and select **Select Folder**.
5. Select **OK** until every window is closed.

[ESET's steps](https://support.eset.com/en/kb2769-exclude-files-or-folders-from-scanning-in-eset-windows-home-products)

### Others

For McAfee, see [McAfee's steps](https://www.mcafee.com/support/s/article/000001661?language=en_US).
For any other antivirus, look for **Exclusions**, **Exceptions** or **Allow list** in its
settings and add `%LOCALAPPDATA%\polaris` as a folder.

## If it still does not open

Remove the exclusion again if it did not help, so the antivirus keeps checking that folder.
Then see [What to check](troubleshooting.md) when a screen says Polaris is not reachable.

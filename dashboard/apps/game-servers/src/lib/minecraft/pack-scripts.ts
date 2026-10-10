/**
 * The two installers a player runs, written here so they can be read, tested and
 * changed like anything else.
 *
 * Both do the same five things: work out where this machine keeps its `mods`
 * folder, read the list Polaris resolved, download what is missing or changed,
 * take away what the pack no longer carries, and move aside a jar of the player's
 * own that is another copy of a mod on the list or one a mod on it cannot run
 * beside. Anything else of theirs - a map mod, a shader loader - stays, and both
 * are safe to run again, which is how somebody updates after the server's list
 * changes.
 *
 * The list is a tab-separated line per mod rather than JSON, because the shell
 * that reads it on a Mac has no JSON parser it can count on, and a mod list with
 * a parser dependency is a mod list that fails on somebody's laptop.
 *
 * Pure: it only builds the text.
 */

/** The file the installers keep beside the jars, naming what they put there. */
export const PACK_RECORD = ".polaris-pack.txt";

/** The first field of a line that names an entry the pack could not resolve. No
 *  mod can wear it: a filename is a bare jar name and this is not one. */
export const UNRESOLVED = "!";

/**
 * Where a jar the installers take out of the way goes: beside `mods`, not in it,
 * so the loader stops seeing it, and not deleted, because it is the player's.
 */
export const SET_ASIDE = "mods-polaris-removed";

/**
 * The server's name, as a line of somebody else's script may carry it.
 *
 * The name is typed by the operator, and the script it goes into is piped into an
 * interpreter on a player's machine - so what reaches it may not be able to end
 * the comment it sits in, close a string, or start a statement. Letters, digits
 * and a handful of marks survive; everything else, newlines and quotes and
 * backticks included, becomes a space.
 */
export function scriptName(server: string): string {
    const safe = server
        .replace(/[^\p{L}\p{N}\p{Zs}._+-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48)
        .trim();
    return safe || "this server";
}

/** A value of somebody else's on a line of its own: no tab to shift the fields
 *  after it, no newline to invent a line that is not there. */
function oneLine(value: string): string {
    return value
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

/**
 * The address the script fetches the list from, as a script may carry it.
 *
 * The host comes off the request, and a hostname may legally hold a quote or a
 * `$` - which inside the double quotes this is written into would be a command
 * the player's shell runs. Anything outside what an address needs is percent
 * encoded, which leaves a real address exactly as it was.
 */
export function scriptUrl(url: string): string {
    return url.replace(/[^A-Za-z0-9._~:/?#[\]@!&*+,;=%()-]/g, (character) =>
        [...new TextEncoder().encode(character)]
            .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
            .join("")
    );
}

/**
 * The game folder and launcher profile a server's mods are installed into.
 *
 * Each server gets a folder of its own under the Minecraft folder, with its own
 * `mods`, and a profile in the official launcher that plays from it. One shared
 * `mods` folder for every server is how a player on two of them ends up with
 * both sets at once - and a server that does not have a mod another one needs
 * on the client turns that player away ("Incompatible client!").
 *
 * The profile needs the mod loader's own entry in the launcher, which the
 * loader's installer adds; `versionGlob` is how the installers find it among
 * what is installed, newest first. Null for software with no client loader of
 * its own, where only the folder is made.
 */
export interface PackProfile {
    /** The folder's name and the profile's key: the server's id. */
    readonly key: string;
    readonly versionGlob: string | null;
    /** What to tell somebody who has not installed the loader yet. */
    readonly loader: string | null;
    /** The release, or empty for a server following the newest. */
    readonly minecraft: string;
}

/** Which loader a player runs to join a server running this software. A hybrid
 *  runs mods of the loader it is built on. */
const CLIENT_LOADERS: Readonly<Record<string, { family: string; name: string }>> = {
    FABRIC: { family: "fabric", name: "Fabric" },
    BANNER: { family: "fabric", name: "Fabric" },
    QUILT: { family: "quilt", name: "Quilt" },
    FORGE: { family: "forge", name: "Forge" },
    MOHIST: { family: "forge", name: "Forge" },
    KETTING: { family: "forge", name: "Forge" },
    NEOFORGE: { family: "neoforge", name: "NeoForge" },
    ARCLIGHT: { family: "neoforge", name: "NeoForge" },
    YOUER: { family: "neoforge", name: "NeoForge" }
};

/** A release named exactly, which is all a version folder can be matched on. */
const RELEASE = /^\d+(?:\.\d+){1,2}$/;

/** NeoForge's number for a release (1.21.4 is 21.4, 26.3 is 26.3.0). */
function neoforgeNumber(minecraft: string): string {
    const parts = minecraft.split(".");
    if (parts[0] === "1") return `${parts[1]}.${parts[2] ?? "0"}.`;
    return `${[...parts, "0", "0"].slice(0, 3).join(".")}.`;
}

/** The folder name under `versions` each loader's installer creates, as a glob. */
function versionGlobOf(family: string, minecraft: string): string {
    const release = RELEASE.test(minecraft) ? minecraft : "";
    switch (family) {
        case "fabric":
            return release ? `fabric-loader-*-${release}` : "fabric-loader-*";
        case "quilt":
            return release ? `quilt-loader-*-${release}` : "quilt-loader-*";
        case "forge":
            return release ? `${release}-forge-*` : "*-forge-*";
        default:
            return release ? `neoforge-${neoforgeNumber(release)}*` : "neoforge-*";
    }
}

/** The id a folder and a profile key may be: what an install id is made of. */
const PROFILE_KEY = /^[A-Za-z0-9-]{1,64}$/;

/** The profile for a server, from its id, `TYPE` and `VERSION`. */
export function packProfile(installedAppId: string, type: string, version: string): PackProfile {
    const key = PROFILE_KEY.test(installedAppId) ? installedAppId : "server";
    const minecraft = RELEASE.test(version.trim()) ? version.trim() : "";
    const client = CLIENT_LOADERS[type.trim().toUpperCase()];
    return {
        key,
        versionGlob: client ? versionGlobOf(client.family, minecraft) : null,
        loader: client?.name ?? null,
        minecraft
    };
}

/** What a script is told of a loader somebody still has to install. */
function loaderAdvice(profile: PackProfile): string {
    if (!profile.loader) return "";
    return profile.minecraft
        ? `${profile.loader} for Minecraft ${profile.minecraft}`
        : profile.loader;
}

/**
 * Where each system keeps Minecraft, and the escape hatch.
 *
 * The mods go into the server's own game folder (see `PackProfile`), under
 * `POLARIS_MC_ROOT` when the Minecraft folder is somewhere else. `POLARIS_MC_DIR`
 * wins over both, because a launcher that keeps its instances elsewhere - Prism,
 * MultiMC, CurseForge - is normal, and the alternative is a script that installs
 * into a folder the player does not use; no profile is made for that one.
 *
 * A run that finds a pack an earlier version of this script put into the shared
 * `mods` folder moves those jars aside, once: they are the other server's half
 * of the mix this exists to end.
 */
export function shellInstaller(
    manifestUrl: string,
    server: string,
    profile: PackProfile = packProfile("server", "", "")
): string {
    return `#!/bin/sh
# Installs the mods for "${scriptName(server)}" into a Minecraft profile of its own.
# Run it again to update. Of your own jars it only moves aside one that is another
# copy of a mod on the list, or one a mod on the list cannot run beside.
set -eu

manifest="${scriptUrl(manifestUrl)}"
foreign="\${manifest%pack.tsv}foreign.tsv"
root="\${POLARIS_MC_ROOT:-}"
if [ -z "$root" ]; then
    case "$(uname -s)" in
        Darwin) root="$HOME/Library/Application Support/minecraft" ;;
        *) root="$HOME/.minecraft" ;;
    esac
fi
game="$root/polaris/${profile.key}"
dir="\${POLARIS_MC_DIR:-}"
own=0
if [ -z "$dir" ]; then
    dir="$game/mods"
    own=1
fi

say() { printf '%s\\n' "$*"; }
die() { say "polaris: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "this needs curl"
mkdir -p "$dir" || die "could not make $dir"
record="$dir/${PACK_RECORD}"
tmp=$(mktemp -d) || die "could not make a temporary folder"
trap 'rm -rf "$tmp"' EXIT

# A pack an earlier run installed into the shared mods folder, where every
# server's mods ended up together. Moved aside, not deleted, and only the jars
# that run recorded as its own.
shared="$root/mods"
if [ "$own" = "1" ] && [ -f "$shared/${PACK_RECORD}" ]; then
    away="$root/${SET_ASIDE}"
    moved=0
    while IFS= read -r old; do
        case "$old" in ""|*/*) continue ;; esac
        if [ -f "$shared/$old" ]; then
            mkdir -p "$away" || die "could not make $away"
            mv "$shared/$old" "$away/$old" && moved=$((moved + 1))
        fi
    done < "$shared/${PACK_RECORD}"
    rm -f "$shared/${PACK_RECORD}"
    say "polaris: moved $moved mods an earlier run put in $shared to $away"
fi

curl -fsSL "$manifest" -o "$tmp/pack.tsv" || die "could not reach Polaris for the mod list"
[ -s "$tmp/pack.tsv" ] || die "the mod list came back empty"

sha_of() {
    if command -v sha1sum >/dev/null 2>&1; then line=$(sha1sum "$1")
    elif command -v shasum >/dev/null 2>&1; then line=$(shasum -a 1 "$1")
    else echo ""; return
    fi
    # A name it had to escape is reported with a backslash before the checksum,
    # and a checksum read with that backslash on it never matches anything - so
    # every mod is downloaded again on a folder whose path has one in it.
    line=\${line#\\\\}
    printf '%s' "\${line%% *}"
}

added=0
kept=0
partial=0
: > "$tmp/wanted"
tab=$(printf '\\t')
while IFS="$tab" read -r name sha url; do
    [ -n "$name" ] || continue
    # An entry Polaris could not resolve to a file right now. It is not a mod the
    # server dropped, so nothing is taken away on a run that sees one.
    if [ "$name" = "${UNRESOLVED}" ]; then
        partial=1
        say "polaris: no build could be worked out for $sha"
        continue
    fi
    printf '%s\\n' "$name" >> "$tmp/wanted"
    if [ -f "$dir/$name" ]; then
        have=$(sha_of "$dir/$name")
        if [ -z "$sha" ] || [ -z "$have" ] || [ "$have" = "$sha" ]; then
            kept=$((kept + 1))
            continue
        fi
    fi
    say "downloading $name"
    curl -fsSL "$url" -o "$tmp/$name" || die "could not download $name"
    if [ -n "$sha" ]; then
        got=$(sha_of "$tmp/$name")
        if [ -n "$got" ] && [ "$got" != "$sha" ]; then die "$name arrived damaged"; fi
    fi
    mv "$tmp/$name" "$dir/$name" || die "could not write $name into $dir"
    added=$((added + 1))
done < "$tmp/pack.tsv"

# The jars in the folder this pack did not put there, named by their contents.
# Polaris answers with the ones that are another copy of a mod on the list - a
# different version under a different name, which the loader refuses to start
# with - or that a mod on the list cannot run beside. Those are moved out of the
# folder, never deleted; everything else of the player's is left where it is.
aside=0
: > "$tmp/foreign"
for jar in "$dir"/*.jar; do
    [ -f "$jar" ] || continue
    name=\${jar##*/}
    if grep -Fxq "$name" "$tmp/wanted"; then continue; fi
    if [ -f "$record" ] && grep -Fxq "$name" "$record"; then continue; fi
    sum=$(sha_of "$jar")
    [ -n "$sum" ] || continue
    printf '%s\\t%s\\n' "$sum" "$name" >> "$tmp/foreign"
done
if [ -s "$tmp/foreign" ]; then
    if curl -fsSL -X POST -H "Content-Type: text/plain" --data-binary @"$tmp/foreign" "$foreign" -o "$tmp/aside"; then
        away="$(dirname "$dir")/${SET_ASIDE}"
        cut -f2 "$tmp/foreign" > "$tmp/foreign-names"
        while IFS="$tab" read -r name why; do
            [ -n "$name" ] || continue
            # Only a name this run sent, and only a file in this folder.
            case "$name" in */*) continue ;; esac
            grep -Fxq "$name" "$tmp/foreign-names" || continue
            [ -f "$dir/$name" ] || continue
            mkdir -p "$away" || die "could not make $away"
            mv "$dir/$name" "$away/$name" || die "could not move $name out of the way"
            aside=$((aside + 1))
            say "moved $name to $away ($why)"
        done < "$tmp/aside"
    else
        say "polaris: could not check your other jars, so none were moved"
    fi
fi

# Only what this pack installed before and the server no longer lists. A jar the
# player added themselves is not in the record and is left alone, and a run that
# could not resolve everything takes nothing away at all: an entry missing from a
# partial list is a mod that may still be needed to join.
removed=0
if [ "$partial" = "1" ]; then
    say "polaris: the list came back partial, so nothing was taken away this time"
elif [ -f "$record" ]; then
    while IFS= read -r old; do
        [ -n "$old" ] || continue
        if ! grep -Fxq "$old" "$tmp/wanted" && [ -f "$dir/$old" ]; then
            rm -f "$dir/$old" && removed=$((removed + 1))
            say "removed $old"
        fi
    done < "$record"
fi

# The record keeps every name it already had on a partial run, so a mod that only
# failed to resolve is still known to be this pack's the next time round.
if [ "$partial" = "1" ]; then
    if [ -f "$record" ]; then cat "$record" >> "$tmp/wanted"; fi
    sort -u "$tmp/wanted" > "$tmp/record"
    cp "$tmp/record" "$record"
else
    cp "$tmp/wanted" "$record"
fi

# The launcher profile that plays from this server's folder. Written with a
# JSON tool the system already has - JavaScript for Automation on a Mac,
# Python elsewhere - and left to the player to add by hand without one.
if [ "$own" = "1" ]; then
    profiles="$root/launcher_profiles.json"
    pattern="${profile.versionGlob ?? ""}"
    version=""
    if [ -n "$pattern" ] && [ -d "$root/versions" ]; then
        version=$(cd "$root/versions" && ls -1td -- $pattern 2>/dev/null | head -n 1) || version=""
    fi
    name="${scriptName(server)} (Polaris)"
    wrote=""
    if [ -z "$pattern" ]; then
        say "polaris: point a launcher profile's game directory at $game to play with these mods"
    elif [ -z "$version" ]; then
        say "polaris: install ${loaderAdvice(profile)} first, then run this line again to add the profile $name"
    elif [ ! -f "$profiles" ]; then
        say "polaris: open the Minecraft Launcher once, then run this line again to add the profile $name"
    elif [ "$(uname -s)" = "Darwin" ]; then
        cat > "$tmp/profile.js" <<'POLARIS_JS'
ObjC.import("Foundation");
function run(argv) {
    var text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
    if (text.isNil()) return "unreadable";
    var data = JSON.parse(ObjC.unwrap(text));
    if (typeof data.profiles !== "object" || data.profiles === null) data.profiles = {};
    var now = new Date().toISOString();
    var entry = data.profiles[argv[1]] || { created: now };
    entry.name = argv[2];
    entry.type = "custom";
    entry.gameDir = argv[3];
    entry.lastVersionId = argv[4];
    entry.lastUsed = now;
    data.profiles[argv[1]] = entry;
    var ok = $(JSON.stringify(data, null, 2)).writeToFileAtomicallyEncodingError(argv[0], true, $.NSUTF8StringEncoding, null);
    return ok ? "ok" : "unwritable";
}
POLARIS_JS
        wrote=$(osascript -l JavaScript "$tmp/profile.js" "$profiles" "${profile.key}" "$name" "$game" "$version" 2>/dev/null) || wrote=""
    elif command -v python3 >/dev/null 2>&1; then
        cat > "$tmp/profile.py" <<'POLARIS_PY'
import datetime, json, os, sys
path, key, name, game, version = sys.argv[1:6]
with open(path, encoding="utf-8") as source:
    data = json.load(source)
if not isinstance(data.get("profiles"), dict):
    data["profiles"] = {}
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
entry = data["profiles"].get(key) or {"created": now}
entry.update({"name": name, "type": "custom", "gameDir": game, "lastVersionId": version, "lastUsed": now})
data["profiles"][key] = entry
with open(path + ".polaris", "w", encoding="utf-8") as target:
    json.dump(data, target, indent=2)
os.replace(path + ".polaris", path)
print("ok")
POLARIS_PY
        wrote=$(python3 "$tmp/profile.py" "$profiles" "${profile.key}" "$name" "$game" "$version" 2>/dev/null) || wrote=""
    fi
    if [ "$wrote" = "ok" ]; then
        say "polaris: the profile $name plays $version with only this server's mods - restart the Minecraft Launcher to see it"
    elif [ -n "$version" ] && [ -f "$profiles" ]; then
        say "polaris: could not add the profile; make one with the game directory $game and $version"
    fi
fi

say ""
say "polaris: $added installed, $kept already current, $removed removed, $aside moved aside"
say "polaris: mods folder $dir"
`;
}

export function powershellInstaller(
    manifestUrl: string,
    server: string,
    profile: PackProfile = packProfile("server", "", "")
): string {
    return `# Installs the mods for "${scriptName(server)}" into a Minecraft profile of its own.
# Run it again to update. Of your own jars it only moves aside one that is another
# copy of a mod on the list, or one a mod on the list cannot run beside.
$ErrorActionPreference = "Stop"

$manifest = "${scriptUrl(manifestUrl)}"
$foreign = $manifest -replace 'pack\\.tsv$', 'foreign.tsv'
$root = $env:POLARIS_MC_ROOT
if (-not $root) { $root = Join-Path $env:APPDATA ".minecraft" }
$game = Join-Path (Join-Path $root "polaris") "${profile.key}"
$dir = $env:POLARIS_MC_DIR
$own = $false
if (-not $dir) { $dir = Join-Path $game "mods"; $own = $true }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$record = Join-Path $dir "${PACK_RECORD}"

# A pack an earlier run installed into the shared mods folder, where every
# server's mods ended up together. Moved aside, not deleted, and only the jars
# that run recorded as its own.
$shared = Join-Path $root "mods"
$sharedRecord = Join-Path $shared "${PACK_RECORD}"
if ($own -and (Test-Path -LiteralPath $sharedRecord)) {
    $away = Join-Path $root "${SET_ASIDE}"
    $moved = 0
    foreach ($old in (Get-Content -LiteralPath $sharedRecord)) {
        if (-not $old -or $old.Contains("/") -or $old.Contains("\\")) { continue }
        $source = Join-Path $shared $old
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            New-Item -ItemType Directory -Force -Path $away | Out-Null
            Move-Item -LiteralPath $source -Destination (Join-Path $away $old) -Force
            $moved++
        }
    }
    Remove-Item -LiteralPath $sharedRecord -Force
    Write-Host "polaris: moved $moved mods an earlier run put in $shared to $away"
}

try { $list = (Invoke-WebRequest -UseBasicParsing -Uri $manifest).Content }
catch { throw "polaris: could not reach Polaris for the mod list" }
if (-not "$list".Trim()) { throw "polaris: the mod list came back empty" }

$wanted = New-Object System.Collections.Generic.List[string]
$added = 0
$kept = 0
$partial = $false
foreach ($line in ("$list" -split "\`n")) {
    $line = $line.Trim("\`r")
    if (-not $line) { continue }
    $parts = $line -split "\`t"
    # An entry Polaris could not resolve to a file right now. It is not a mod the
    # server dropped, so nothing is taken away on a run that sees one.
    if ($parts[0] -eq "${UNRESOLVED}") {
        $partial = $true
        Write-Host "polaris: no build could be worked out for $($parts[1])"
        continue
    }
    if ($parts.Count -lt 3) { continue }
    $name = $parts[0]; $sha = $parts[1]; $url = $parts[2]
    $wanted.Add($name) | Out-Null
    $target = Join-Path $dir $name
    if (Test-Path -LiteralPath $target) {
        $have = (Get-FileHash -Algorithm SHA1 -LiteralPath $target).Hash.ToLower()
        if (-not $sha -or $have -eq $sha.ToLower()) { $kept++; continue }
    }
    Write-Host "downloading $name"
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temp
    if ($sha) {
        $got = (Get-FileHash -Algorithm SHA1 -LiteralPath $temp).Hash.ToLower()
        if ($got -ne $sha.ToLower()) { Remove-Item -LiteralPath $temp -Force; throw "polaris: $name arrived damaged" }
    }
    Move-Item -LiteralPath $temp -Destination $target -Force
    $added++
}

# The jars in the folder this pack did not put there, named by their contents.
# Polaris answers with the ones that are another copy of a mod on the list or that
# a mod on it cannot run beside. Those are moved out of the folder, never deleted.
$aside = 0
$recorded = @()
if (Test-Path -LiteralPath $record) { $recorded = @(Get-Content -LiteralPath $record) }
$found = New-Object System.Collections.Generic.List[string]
$sent = New-Object System.Collections.Generic.List[string]
foreach ($jar in (Get-ChildItem -LiteralPath $dir -Filter *.jar -File)) {
    if ($wanted -contains $jar.Name -or $recorded -contains $jar.Name) { continue }
    $sum = (Get-FileHash -Algorithm SHA1 -LiteralPath $jar.FullName).Hash.ToLower()
    $found.Add("$sum\`t$($jar.Name)") | Out-Null
    $sent.Add($jar.Name) | Out-Null
}
if ($found.Count -gt 0) {
    $answer = $null
    try {
        $answer = (Invoke-WebRequest -UseBasicParsing -Method Post -ContentType "text/plain; charset=utf-8" -Body ([string]::Join("\`n", $found)) -Uri $foreign).Content
    } catch {
        Write-Host "polaris: could not check your other jars, so none were moved"
    }
    if ($answer) {
        $away = Join-Path (Split-Path -Parent $dir) "${SET_ASIDE}"
        foreach ($line in ("$answer" -split "\`n")) {
            $line = $line.Trim("\`r")
            if (-not $line) { continue }
            $parts = $line -split "\`t"
            $name = $parts[0]
            $why = ""
            if ($parts.Count -gt 1) { $why = $parts[1] }
            # Only a name this run sent, and only a file in this folder.
            if ($sent -notcontains $name) { continue }
            $source = Join-Path $dir $name
            if (-not (Test-Path -LiteralPath $source)) { continue }
            New-Item -ItemType Directory -Force -Path $away | Out-Null
            Move-Item -LiteralPath $source -Destination (Join-Path $away $name) -Force
            $aside++
            Write-Host "moved $name to $away ($why)"
        }
    }
}

# Only what this pack installed before and the server no longer lists, and
# nothing at all on a run whose list came back partial.
$removed = 0
if ($partial) {
    Write-Host "polaris: the list came back partial, so nothing was taken away this time"
} elseif (Test-Path -LiteralPath $record) {
    foreach ($old in (Get-Content -LiteralPath $record)) {
        if (-not $old) { continue }
        if ($wanted -notcontains $old) {
            $stale = Join-Path $dir $old
            if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force; $removed++; Write-Host "removed $old" }
        }
    }
}

# The record keeps every name it already had on a partial run, so a mod that only
# failed to resolve is still known to be this pack's the next time round.
$keep = $wanted
if ($partial -and (Test-Path -LiteralPath $record)) {
    $keep = New-Object System.Collections.Generic.List[string]
    foreach ($name in $wanted) { if ($keep -notcontains $name) { $keep.Add($name) | Out-Null } }
    foreach ($old in (Get-Content -LiteralPath $record)) {
        if ($old -and $keep -notcontains $old) { $keep.Add($old) | Out-Null }
    }
}
Set-Content -LiteralPath $record -Value $keep -Encoding utf8

# The launcher profile that plays from this server's folder.
if ($own) {
    $profiles = Join-Path $root "launcher_profiles.json"
    $pattern = "${profile.versionGlob ?? ""}"
    $name = "${scriptName(server)} (Polaris)"
    $version = $null
    $versions = Join-Path $root "versions"
    if ($pattern -and (Test-Path -LiteralPath $versions)) {
        $found = Get-ChildItem -LiteralPath $versions -Directory -Filter $pattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($found) { $version = $found.Name }
    }
    if (-not $pattern) {
        Write-Host "polaris: point a launcher profile's game directory at $game to play with these mods"
    } elseif (-not $version) {
        Write-Host "polaris: install ${loaderAdvice(profile)} first, then run this line again to add the profile $name"
    } elseif (-not (Test-Path -LiteralPath $profiles)) {
        Write-Host "polaris: open the Minecraft Launcher once, then run this line again to add the profile $name"
    } else {
        try {
            $data = [System.IO.File]::ReadAllText($profiles) | ConvertFrom-Json
            if (-not ($data.PSObject.Properties.Name -contains "profiles") -or $null -eq $data.profiles) {
                $data | Add-Member -NotePropertyName "profiles" -NotePropertyValue ([pscustomobject]@{}) -Force
            }
            $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            $created = $now
            $existing = $data.profiles.PSObject.Properties["${profile.key}"]
            if ($existing -and $existing.Value.created) { $created = $existing.Value.created }
            $entry = [pscustomobject]@{
                name = $name
                type = "custom"
                created = $created
                lastUsed = $now
                lastVersionId = $version
                gameDir = $game
            }
            $data.profiles | Add-Member -NotePropertyName "${profile.key}" -NotePropertyValue $entry -Force
            $json = $data | ConvertTo-Json -Depth 32
            $temp = "$profiles.polaris"
            [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding $false))
            Move-Item -LiteralPath $temp -Destination $profiles -Force
            Write-Host "polaris: the profile $name plays $version with only this server's mods - restart the Minecraft Launcher to see it"
        } catch {
            Write-Host "polaris: could not add the profile; make one with the game directory $game and $version"
        }
    }
}

Write-Host ""
Write-Host "polaris: $added installed, $kept already current, $removed removed, $aside moved aside"
Write-Host "polaris: mods folder $dir"
`;
}

/**
 * The list both installers read: one mod per line, tab separated.
 *
 * What could not be resolved is on it too, as a line the installers read as "not
 * a mod that went away". Leaving those out would make a Modrinth outage
 * indistinguishable from an operator taking a mod off the list, and the installer
 * would take a jar the player still needs to join.
 */
export function packTable(
    mods: readonly { filename: string; sha1: string; url: string }[],
    missing: readonly string[] = []
): string {
    const lines = mods.map((mod) => `${mod.filename}\t${mod.sha1}\t${mod.url}\n`);
    for (const entry of missing) lines.push(`${UNRESOLVED}\t${oneLine(entry)}\n`);
    return lines.join("");
}

/**
 * Polaris's answer about a player's own jars: one per line, the name and why it
 * is being moved aside. Both reach a script on somebody else's machine, so each
 * is kept to one line with no tab of its own.
 */
export function asideTable(moves: readonly { name: string; reason: string }[]): string {
    return moves.map((move) => `${oneLine(move.name)}\t${oneLine(move.reason)}\n`).join("");
}

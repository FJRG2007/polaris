/**
 * The two installers a player runs, written here so they can be read, tested and
 * changed like anything else.
 *
 * Both do the same four things: work out where this machine keeps its `mods`
 * folder, read the list Polaris resolved, download what is missing or changed,
 * and take away what the pack no longer carries. Neither touches a jar it did not
 * put there - a player's own map mod stays - and both are safe to run again,
 * which is how somebody updates after the server's list changes.
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
 * Where each system keeps Minecraft, and the escape hatch.
 *
 * `POLARIS_MC_DIR` wins everywhere, because a launcher that keeps its instances
 * elsewhere - Prism, MultiMC, CurseForge - is normal, and the alternative is a
 * script that installs into a folder the player does not use.
 */
export function shellInstaller(manifestUrl: string, server: string): string {
    return `#!/bin/sh
# Installs the mods for "${scriptName(server)}" into this machine's Minecraft folder.
# Run it again to update. It only ever touches jars it installed itself.
set -eu

manifest="${scriptUrl(manifestUrl)}"
dir="\${POLARIS_MC_DIR:-}"
if [ -z "$dir" ]; then
    case "$(uname -s)" in
        Darwin) dir="$HOME/Library/Application Support/minecraft/mods" ;;
        *) dir="$HOME/.minecraft/mods" ;;
    esac
fi

say() { printf '%s\\n' "$*"; }
die() { say "polaris: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "this needs curl"
mkdir -p "$dir" || die "could not make $dir"
record="$dir/${PACK_RECORD}"
tmp=$(mktemp -d) || die "could not make a temporary folder"
trap 'rm -rf "$tmp"' EXIT

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

say ""
say "polaris: $added installed, $kept already current, $removed removed"
say "polaris: mods folder $dir"
`;
}

export function powershellInstaller(manifestUrl: string, server: string): string {
    return `# Installs the mods for "${scriptName(server)}" into this machine's Minecraft folder.
# Run it again to update. It only ever touches jars it installed itself.
$ErrorActionPreference = "Stop"

$manifest = "${scriptUrl(manifestUrl)}"
$dir = $env:POLARIS_MC_DIR
if (-not $dir) { $dir = Join-Path $env:APPDATA ".minecraft\\mods" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$record = Join-Path $dir "${PACK_RECORD}"

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

Write-Host ""
Write-Host "polaris: $added installed, $kept already current, $removed removed"
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

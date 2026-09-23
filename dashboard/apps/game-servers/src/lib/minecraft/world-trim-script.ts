/**
 * The world optimizer, as the text that is put into the container and run there.
 *
 * Kept as a string rather than as a file beside this one because of how this app
 * ships: Game servers is bundled, and a bundler carries the modules it can see
 * imported, not a Python file sitting next to them. A file would work in a
 * checkout and be missing from every installed Polaris, which is the worse of the
 * two failures by a distance.
 *
 * Python because that is what is actually in the container. The Minecraft image
 * is built on Ubuntu and carries python3; it carries a Java runtime and no
 * compiler, so a small Java tool could not be built in there, and it carries no
 * Node. Nothing in the script imports anything outside the standard library.
 *
 * What it does, and why each rule is the way it is, is documented in the script
 * itself - it is the thing somebody will read when they want to know what was
 * taken out of their world.
 */

/** The optimizer. Written into the container and run against a stopped server. */
export const WORLD_TRIM_SCRIPT = `#!/usr/bin/env python3
"""Remove the chunks of a Minecraft world nobody has ever been in.

A generated world is mostly places nobody went. Every chunk a player loads is
written to disk and kept forever, so a server that has been up for a year carries
tens of thousands of chunks that were rendered once from the edge of somebody's
view distance and never entered. They are the same chunks the game would generate
again, identically, from the same seed - so keeping them costs disk, backups and
the time every copy of the world takes, and deleting them costs nothing anybody
can see.

The test is the chunk's own \`InhabitedTime\`: the number of ticks a player has
spent inside it. The game keeps that count for its own purposes (it drives local
difficulty), which makes it the one number in a region file that means "somebody
was here" without this script having to know anything about mods, plugins, or
what people build. A chunk anybody has stood in is kept. Everything else is
regenerable.

Chunks that are kept whatever their inhabited time:
  - anything force-loaded, which is a deliberate statement that the chunk matters
    even with nobody in it - a chunk loader, a farm, a mod keeping its machine
    ticking;
  - the spawn area, which the server keeps loaded and which is where anybody who
    dies without a bed arrives;
  - every chunk near where a player logged out or set their spawn point, since a
    spawn point can be set from anywhere by a command;
  - anything this script cannot read with certainty. A chunk whose compression it
    does not recognise, whose header is short, or whose \`InhabitedTime\` it cannot
    find is kept. "I could not tell" is never allowed to mean "delete it".

Nothing is edited in place. Each region file is rebuilt beside itself and moved
over the original only once it is complete, so an interrupted run leaves every
world file exactly as it was.

Java Edition only: Bedrock keeps its world in a key-value store, not in region
files, and nothing here would find anything to do in one.
"""

import argparse
import gzip
import json
import os
import struct
import sys
import zlib

# A region file opens with two 4 KiB tables of 1024 big-endian words each: where
# every chunk is, and when it was last written.
SECTOR = 4096
SLOTS = 1024
HEADER = SECTOR * 2

# The tag this whole script turns on, as it appears in the uncompressed chunk:
# a TAG_Long (4), a two-byte name length, and the name. The eight bytes after it
# are the count itself.
INHABITED = b"\\x04\\x00\\x0dInhabitedTime"

# How the payload after a chunk header is compressed. The high bit means the
# chunk was too big for the region file and lives beside it in its own \`.mcc\`,
# which this script never opens and never deletes.
EXTERNAL = 0x80
GZIP, ZLIB, NONE = 1, 2, 3

class Unreadable(Exception):
    """A file this script will not touch, with the reason it gave up."""

def chunk_payload(data, compression):
    """The chunk as NBT bytes, or None when its compression is not one we read.

    LZ4 (1.20.5 and later, and only when somebody turned it on) is deliberately
    not decompressed here: unpacking it needs a library the server image does not
    carry, and a chunk this cannot read is a chunk it keeps.
    """
    try:
        if compression == ZLIB:
            return zlib.decompress(data)
        if compression == GZIP:
            return gzip.decompress(data)
        if compression == NONE:
            return data
    except Exception:
        return None
    return None

def inhabited_ticks(payload):
    """How long players have spent in this chunk, or None when it does not say.

    Found by looking for the tag rather than by walking the whole compound. A
    chunk is a deeply nested structure whose shape has changed several times
    across releases, and this one number has had the same name and the same type
    throughout - so the search costs a scan of a few tens of kilobytes and
    survives formats this script has never seen.
    """
    at = payload.find(INHABITED)
    if at < 0:
        return None
    start = at + len(INHABITED)
    if start + 8 > len(payload):
        return None
    return struct.unpack_from(">q", payload, start)[0]

def read_nbt_file(path):
    """A gzipped NBT file as raw bytes, or None when it is not there or not that.

    Every one of these is optional - a world with nobody in it has no player data
    and a world with nothing force-loaded has no tickets file - so absence is an
    ordinary answer and never an error.
    """
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        return None
    if raw[:2] == b"\\x1f\\x8b":
        try:
            return gzip.decompress(raw)
        except Exception:
            return None
    return raw

def forced_chunks(dimension):
    """The chunks this dimension has been told to keep loaded.

    Both spellings: the modern one is a list of tickets in
    \`data/minecraft/chunk_tickets.dat\`, the older one a long array called
    \`Forced\` in \`data/chunks.dat\`, and each packs a chunk position into one
    64-bit value as two 32-bit halves.
    """
    keep = set()
    for name in ("data/minecraft/chunk_tickets.dat", "data/chunks.dat"):
        raw = read_nbt_file(os.path.join(dimension, name))
        if raw is None:
            continue
        # \`Forced\`: a TAG_Long_Array whose every entry is one chunk position.
        marker = b"\\x0c\\x00\\x06Forced"
        at = raw.find(marker)
        if at >= 0:
            start = at + len(marker)
            if start + 4 <= len(raw):
                count = struct.unpack_from(">i", raw, start)[0]
                start += 4
                for index in range(max(0, min(count, 100000))):
                    if start + 8 > len(raw):
                        break
                    x, z = struct.unpack_from(">ii", raw, start)
                    keep.add((x, z))
                    start += 8
        # \`chunk_pos\`: a TAG_Int_Array of two entries inside each ticket. Every
        # one of them is kept, whatever the ticket is for - a ticket that is not
        # a forced load still says the server was asked to hold that chunk.
        marker = b"\\x0b\\x00\\x09chunk_pos"
        at = raw.find(marker)
        while at >= 0:
            start = at + len(marker)
            if start + 12 <= len(raw):
                count, x, z = struct.unpack_from(">iii", raw, start)
                if count == 2:
                    keep.add((x, z))
            at = raw.find(marker, at + 1)
    return keep

def spawn_chunk(level_dat):
    """Where the world spawns, as a chunk, or None when the file says nothing."""
    raw = read_nbt_file(level_dat)
    if raw is None:
        return None
    found = {}
    for axis in ("SpawnX", "SpawnZ"):
        marker = b"\\x03\\x00" + bytes([len(axis)]) + axis.encode("ascii")
        at = raw.find(marker)
        if at < 0:
            return None
        start = at + len(marker)
        if start + 4 > len(raw):
            return None
        found[axis] = struct.unpack_from(">i", raw, start)[0]
    return (found["SpawnX"] >> 4, found["SpawnZ"] >> 4)

def player_chunks(world):
    """Where each player was and where each player respawns, as chunks.

    A base somebody built has inhabited time by definition, so this is not about
    bases. It is about the position a command can set from anywhere: a spawn
    point placed in a chunk nobody has walked through would otherwise be a
    respawn into freshly generated ground.
    """
    keep = set()
    folder = os.path.join(world, "playerdata")
    try:
        names = os.listdir(folder)
    except OSError:
        return keep
    for name in names:
        if not name.endswith(".dat"):
            continue
        raw = read_nbt_file(os.path.join(folder, name))
        if raw is None:
            continue
        # Pos: a TAG_List of three doubles, the player where they logged out.
        marker = b"\\x09\\x00\\x03Pos"
        at = raw.find(marker)
        if at >= 0:
            start = at + len(marker)
            if start + 5 + 24 <= len(raw) and raw[start] == 6:
                x, _y, z = struct.unpack_from(">ddd", raw, start + 5)
                keep.add((int(x) >> 4, int(z) >> 4))
        # The respawn point, which older releases spell as three ints and newer
        # ones as a compound holding the same three names.
        found = {}
        for axis in ("SpawnX", "SpawnZ"):
            marker = b"\\x03\\x00" + bytes([len(axis)]) + axis.encode("ascii")
            at = raw.find(marker)
            if at < 0:
                continue
            start = at + len(marker)
            if start + 4 <= len(raw):
                found[axis] = struct.unpack_from(">i", raw, start)[0]
        if len(found) == 2:
            keep.add((found["SpawnX"] >> 4, found["SpawnZ"] >> 4))
    return keep

def within(point, centres, radius):
    """Whether a chunk is inside the square of \`radius\` chunks around any of these."""
    x, z = point
    for cx, cz in centres:
        if abs(x - cx) <= radius and abs(z - cz) <= radius:
            return True
    return False

def read_header(handle):
    """Where every chunk in this region file is, and when it was last written."""
    handle.seek(0)
    head = handle.read(HEADER)
    if len(head) < HEADER:
        raise Unreadable("header is shorter than a region file header")
    places = struct.unpack_from(">1024I", head, 0)
    stamps = struct.unpack_from(">1024I", head, SECTOR)
    slots = []
    for index in range(SLOTS):
        word = places[index]
        offset = (word >> 8) * SECTOR
        length = (word & 0xFF) * SECTOR
        if offset == 0 or length == 0:
            slots.append(None)
            continue
        slots.append((offset, length, stamps[index]))
    return slots

def keep_chunk(raw, threshold):
    """Whether this chunk stays, from the bytes of its slot in the region file.

    Every uncertainty answers yes. The cost of keeping a chunk that could have
    gone is a few kilobytes; the cost of removing one that should have stayed is
    somebody's build.
    """
    if len(raw) < 5:
        return True
    length, compression = struct.unpack_from(">IB", raw, 0)
    if compression & EXTERNAL:
        return True
    if length < 1 or 4 + length > len(raw):
        return True
    payload = chunk_payload(raw[5 : 4 + length], compression)
    if payload is None:
        return True
    ticks = inhabited_ticks(payload)
    if ticks is None:
        return True
    return ticks > threshold

def trim_region(paths, keep_always, threshold, dry_run):
    """Rebuild one region file without the chunks nobody has been in.

    \`paths\` is the chunk file and its two companions - the entities and the
    points of interest of the same region - which are rebuilt with exactly the
    same slots. Keeping a chunk and dropping its entities would be a chunk whose
    mobs and villagers vanish.
    """
    region, entities, poi = paths
    name = os.path.basename(region)
    parts = name.split(".")
    region_x, region_z = int(parts[1]), int(parts[2])

    handles = {}
    try:
        handles[region] = open(region, "rb")
        slots = read_header(handles[region])
        for path in (entities, poi):
            if path and os.path.exists(path):
                try:
                    handles[path] = open(path, "rb")
                except OSError:
                    handles[path] = None

        companions = {}
        for path in (entities, poi):
            handle = handles.get(path)
            if handle is None:
                continue
            try:
                companions[path] = read_header(handle)
            except Unreadable:
                companions[path] = None

        kept, removed = [], 0
        for index in range(SLOTS):
            slot = slots[index]
            if slot is None:
                continue
            offset, length, stamp = slot
            handles[region].seek(offset)
            raw = handles[region].read(length)
            point = (region_x * 32 + (index % 32), region_z * 32 + (index // 32))
            if within(point, keep_always, 0) or keep_chunk(raw, threshold):
                kept.append((index, raw, stamp))
            else:
                removed += 1

        if removed == 0:
            return {"kept": len(kept), "removed": 0, "freed": 0}

        freed = 0
        before = os.path.getsize(region)
        if dry_run:
            freed = before - written_size(kept)
        else:
            write_region(region, kept)
            freed = before - os.path.getsize(region)
            keep_indices = {index for index, _raw, _stamp in kept}
            for path, theirs in companions.items():
                if theirs is None:
                    continue
                rebuilt = []
                for index in range(SLOTS):
                    slot = theirs[index]
                    if slot is None or index not in keep_indices:
                        continue
                    offset, length, stamp = slot
                    handles[path].seek(offset)
                    rebuilt.append((index, handles[path].read(length), stamp))
                was = os.path.getsize(path)
                write_region(path, rebuilt)
                freed += was - os.path.getsize(path)
        return {"kept": len(kept), "removed": removed, "freed": freed}
    finally:
        for handle in handles.values():
            if handle is not None:
                handle.close()

def written_size(entries):
    """How big a region file holding exactly these chunks would be."""
    total = HEADER
    for _index, raw, _stamp in entries:
        total += (len(raw) + SECTOR - 1) // SECTOR * SECTOR
    return total

def write_region(path, entries):
    """Write a region file holding these chunks, and put it where \`path\` is.

    Beside the original and then moved over it, so a run that is killed halfway
    leaves the world exactly as it was rather than half a region file.
    """
    temporary = path + ".polaris-new"
    places = [0] * SLOTS
    stamps = [0] * SLOTS
    with open(temporary, "wb") as out:
        out.write(b"\\0" * HEADER)
        cursor = HEADER
        for index, raw, stamp in entries:
            padded = (len(raw) + SECTOR - 1) // SECTOR * SECTOR
            out.write(raw)
            out.write(b"\\0" * (padded - len(raw)))
            places[index] = ((cursor // SECTOR) << 8) | (padded // SECTOR)
            stamps[index] = stamp
            cursor += padded
        out.seek(0)
        out.write(struct.pack(">1024I", *places))
        out.write(struct.pack(">1024I", *stamps))
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)

def dimensions(world):
    """Every folder under this world that holds region files.

    Found by looking rather than by naming them: the Nether and the End are two
    of them, and a datapack or a mod can add any number more under names this
    script has never heard of.
    """
    found = []
    for root, folders, _files in os.walk(world):
        if "region" in folders:
            found.append(root)
        # The chunk folders themselves hold no dimensions, and walking into one
        # is thousands of files read for nothing.
        for skip in ("region", "entities", "poi"):
            if skip in folders:
                folders.remove(skip)
    return found

def region_files(dimension):
    """The region files of one dimension, each with its entities and poi twins."""
    folder = os.path.join(dimension, "region")
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return []
    found = []
    for name in names:
        if not name.endswith(".mca") or not name.startswith("r."):
            continue
        parts = name.split(".")
        if len(parts) != 4:
            continue
        try:
            int(parts[1])
            int(parts[2])
        except ValueError:
            continue
        path = os.path.join(folder, name)
        if os.path.getsize(path) < HEADER:
            continue
        found.append(
            (
                path,
                os.path.join(dimension, "entities", name),
                os.path.join(dimension, "poi", name)
            )
        )
    return found

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--world", required=True, help="the world folder")
    parser.add_argument(
        "--keep-ticks",
        type=int,
        default=0,
        help="keep a chunk with more than this many ticks of inhabited time"
    )
    parser.add_argument(
        "--keep-radius",
        type=int,
        default=8,
        help="chunks to keep around spawn and around every player position"
    )
    parser.add_argument("--dry-run", action="store_true", help="measure without changing anything")
    args = parser.parse_args()

    world = args.world
    if not os.path.isdir(world):
        print(json.dumps({"error": "that is not a world folder"}))
        return 2

    report = {
        "world": world,
        "dryRun": bool(args.dry_run),
        "dimensions": 0,
        "regions": 0,
        "kept": 0,
        "removed": 0,
        "freedBytes": 0,
        "skipped": []
    }

    spawn = spawn_chunk(os.path.join(world, "level.dat"))
    players = player_chunks(world)
    radius = max(0, args.keep_radius)

    for dimension in dimensions(world):
        files = region_files(dimension)
        if not files:
            continue
        report["dimensions"] += 1
        forced = forced_chunks(dimension)
        # The overworld is the only one spawn and player positions are about; a
        # coordinate in the Nether is a different place with the same numbers.
        centres = set(forced)
        if dimension == world:
            for centre in ({spawn} if spawn else set()) | players:
                for dx in range(-radius, radius + 1):
                    for dz in range(-radius, radius + 1):
                        centres.add((centre[0] + dx, centre[1] + dz))
        for paths in files:
            try:
                result = trim_region(paths, centres, args.keep_ticks, args.dry_run)
            except Unreadable as error:
                report["skipped"].append({"file": os.path.basename(paths[0]), "why": str(error)})
                continue
            except Exception as error:  # noqa: BLE001 - one bad file is not the run
                report["skipped"].append({"file": os.path.basename(paths[0]), "why": str(error)})
                continue
            report["regions"] += 1
            report["kept"] += result["kept"]
            report["removed"] += result["removed"]
            report["freedBytes"] += result["freed"]

    print(json.dumps(report))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

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
"""Remove the chunks of a Minecraft world that are provably untouched worldgen.

A generated world is mostly places nobody went. Every chunk a player loads is
written to disk and kept forever, so a server that has been up for a year carries
tens of thousands of chunks that were rendered once from the edge of somebody's
view distance and never entered. They are the same chunks the game would generate
again, identically, from the same seed.

The first test is the chunk's own \`InhabitedTime\`: the number of ticks a player
has spent near it. It is necessary and it is not sufficient. On 2026-11-21 a run
of an earlier version of this script removed 443 chunks holding chests, beds and
signs from a modded server, every one of them with an \`InhabitedTime\` of 0: a mod,
a pregenerator, an imported world or a chunk loader can all leave a chunk with
things in it and no inhabited time at all. So a chunk only goes when every one of
these says it is empty:

  - its inhabited time is not above the threshold (0 by default);
  - it holds no block entity at all - no chest, sign, bed, furnace, spawner,
    or any modded machine, whether worldgen put it there or a player did;
  - it holds no entity, in the chunk itself (before 1.17) or in the matching
    chunk of \`entities/\` (1.17 and later);
  - it holds no point of interest in the matching chunk of \`poi/\` - no bed,
    workstation, bell, portal or beehive anybody or anything registered;
  - no mod has attached data to it (\`ForgeCaps\`, NeoForge or Fabric attachments).

Chunks that are kept whatever any of that says:
  - anything force-loaded, or holding any chunk ticket;
  - the spawn area, and every chunk near where a player logged out or set their
    spawn point;
  - anything this script cannot read with certainty. A chunk whose compression it
    does not recognise, whose header is short, whose companion it cannot read,
    or where it cannot find the tags it looks for is kept.
    "I could not tell" is never allowed to mean "delete it".

Two refusals stop the whole run before anything is written:
  - the inhabited-time check: a player's logout chunk in the overworld with an
    \`InhabitedTime\` of 0 means this world does not count inhabited time (a mod
    or a converted world), and the first rule above means nothing on it;
  - the ceiling: in any dimension, removing more than half of the chunks that
    finished generating. Chunks that never finished generating (a \`Status\` short
    of full) are provably untouched - the game lets nobody into them - and are
    not counted either way. A world people play in loses roughly a third of its
    finished chunks to this (the ring between the inhabited radius around each
    player and the view distance). More than half means the chunks were made by
    something other than people walking about - a pregenerator, Distant Horizons,
    a chunk-loading mod - which is exactly where inhabited time stops being
    evidence, so the run is refused and nothing is touched.

Before anything is rewritten, the world (with its \`_nether\`/\`_the_end\` folders
when they sit beside it) is copied into \`backups/\` beside it, read back in full,
and checked to hold \`level.dat\` and every file about to change at the same size.
No verified copy, no rewrite.

Nothing is edited in place. Each file is rebuilt beside itself, given the owner
and permissions of the file it replaces, and moved over it only once complete,
so an interrupted run leaves every world file exactly as it was and the server
can always write what it wrote before.

Java Edition only: Bedrock keeps its world in a key-value store, not in region
files, and nothing here would find anything to do in one.
"""

import argparse
import datetime
import gzip
import json
import os
import shutil
import stat
import struct
import sys
import tarfile
import zlib

# A region file opens with two 4 KiB tables of 1024 big-endian words each: where
# every chunk is, and when it was last written.
SECTOR = 4096
SLOTS = 1024
HEADER = SECTOR * 2

# How the payload after a chunk header is compressed. The high bit means the
# chunk was too big for the region file and lives beside it in its own \`.mcc\`,
# which this script never opens and never deletes.
EXTERNAL = 0x80
GZIP, ZLIB, NONE = 1, 2, 3

# The share of finished chunks in one dimension above which a run is refused.
MAX_SHARE = 0.5

# The generation steps a chunk passes through before it is \`full\`, across every
# release that writes a \`Status\`. A chunk stopped at one of them was never
# playable. Anything not on this list - \`full\`, a name from a release this has
# never seen, no status at all - counts as finished.
UNFINISHED = {
    "empty", "structure_starts", "structure_references", "biomes", "noise",
    "surface", "carvers", "liquid_carvers", "features", "initialize_light",
    "light", "spawn", "heightmaps", "base", "carved", "liquid_carved",
    "decorated", "lighted"
}

# Data a loader keeps on a chunk on behalf of mods. Present and non-empty means
# some mod decided this chunk carries something.
ATTACHMENTS = ("ForgeCaps", "neoforge:attachments", "fabric:attachments")

DIMENSION_SUFFIXES = ("_nether", "_the_end")

class Unreadable(Exception):
    """A file this script will not touch, with the reason it gave up."""

class Refused(Exception):
    """The run as a whole will not go ahead; nothing has been written."""

    def __init__(self, reason, **detail):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail

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

def slot_payload(raw):
    """The NBT inside one region slot, or None when it cannot be read with certainty."""
    if raw is None or len(raw) < 5:
        return None
    length, compression = struct.unpack_from(">IB", raw, 0)
    if compression & EXTERNAL:
        return None
    if length < 1 or 4 + length > len(raw):
        return None
    return chunk_payload(raw[5 : 4 + length], compression)

def marker(kind, name):
    """A named tag as it appears in NBT: its type, a two-byte name length, the name."""
    encoded = name.encode("utf-8")
    return bytes([kind]) + struct.pack(">H", len(encoded)) + encoded

def occurrences(payload, tag):
    """Every offset just past this tag's name.

    Found by looking for the tag rather than by walking the compound: the shape of
    a chunk has changed several times across releases and mods add to it, and the
    names this looks for have kept their type throughout. A false match can only
    ever make a chunk look fuller, which keeps it.
    """
    at = payload.find(tag)
    while at >= 0:
        yield at + len(tag)
        at = payload.find(tag, at + 1)

def list_lengths(payload, name):
    """The length of every TAG_List with this name, or None where it was cut short."""
    found = []
    for start in occurrences(payload, marker(9, name)):
        if start + 5 > len(payload):
            found.append(None)
        else:
            found.append(struct.unpack_from(">i", payload, start + 1)[0])
    return found

def any_listed(payload, name):
    """Whether any list with this name has anything in it (or might)."""
    return any(length is None or length != 0 for length in list_lengths(payload, name))

def any_compound_filled(payload, name):
    """Whether any compound with this name holds anything (or might)."""
    for start in occurrences(payload, marker(10, name)):
        if start >= len(payload) or payload[start] != 0:
            return True
    return False

def string_value(payload, name):
    """The first TAG_String with this name, or None."""
    for start in occurrences(payload, marker(8, name)):
        if start + 2 > len(payload):
            return None
        size = struct.unpack_from(">H", payload, start)[0]
        if start + 2 + size > len(payload):
            return None
        try:
            return payload[start + 2 : start + 2 + size].decode("utf-8")
        except UnicodeDecodeError:
            return None
    return None

def inhabited_ticks(payload):
    """How long players have spent near this chunk, or None when it does not say."""
    for start in occurrences(payload, marker(4, "InhabitedTime")):
        if start + 8 > len(payload):
            return None
        return struct.unpack_from(">q", payload, start)[0]
    return None

def unfinished(payload):
    """Whether this chunk provably never finished generating."""
    status = string_value(payload, "Status")
    if status is None:
        return False
    if status.startswith("minecraft:"):
        status = status[len("minecraft:"):]
    return status in UNFINISHED

def chunk_verdict(raw, threshold):
    """(empty, unfinished, ticks) for one region slot; empty is False on any doubt."""
    payload = slot_payload(raw)
    if payload is None:
        return (False, False, None)
    ticks = inhabited_ticks(payload)
    if ticks is None or ticks > threshold:
        return (False, False, ticks)
    # One of the two spellings is in every chunk this script knows how to read:
    # \`block_entities\` since 1.18, \`TileEntities\` before. Neither means a format
    # it does not know, which is a chunk it keeps.
    blocks = list_lengths(payload, "block_entities") + list_lengths(payload, "TileEntities")
    if not blocks or any(length is None or length != 0 for length in blocks):
        return (False, False, ticks)
    if any_listed(payload, "Entities"):
        return (False, False, ticks)
    if any(any_compound_filled(payload, name) for name in ATTACHMENTS):
        return (False, False, ticks)
    return (True, unfinished(payload), ticks)

def entities_empty(raw):
    """Whether the matching chunk of \`entities/\` provably holds no entity."""
    payload = slot_payload(raw)
    if payload is None:
        return False
    lengths = list_lengths(payload, "Entities")
    return bool(lengths) and all(length == 0 for length in lengths)

def poi_empty(raw):
    """Whether the matching chunk of \`poi/\` provably holds no point of interest."""
    payload = slot_payload(raw)
    if payload is None:
        return False
    if not list(occurrences(payload, marker(10, "Sections"))):
        return False
    return not any_listed(payload, "Records")

def read_nbt_file(path):
    """A gzipped NBT file as raw bytes, or None when it is not there or not that."""
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
        for start in occurrences(raw, marker(12, "Forced")):
            if start + 4 > len(raw):
                continue
            count = struct.unpack_from(">i", raw, start)[0]
            start += 4
            for _index in range(max(0, min(count, 100000))):
                if start + 8 > len(raw):
                    break
                x, z = struct.unpack_from(">ii", raw, start)
                keep.add((x, z))
                start += 8
        for start in occurrences(raw, marker(11, "chunk_pos")):
            if start + 12 <= len(raw):
                count, x, z = struct.unpack_from(">iii", raw, start)
                if count == 2:
                    keep.add((x, z))
    return keep

def int_value(raw, name):
    for start in occurrences(raw, marker(3, name)):
        if start + 4 <= len(raw):
            return struct.unpack_from(">i", raw, start)[0]
    return None

def spawn_chunk(level_dat):
    """Where the world spawns, as a chunk, or None when the file says nothing."""
    raw = read_nbt_file(level_dat)
    if raw is None:
        return None
    x, z = int_value(raw, "SpawnX"), int_value(raw, "SpawnZ")
    if x is None or z is None:
        return None
    return (x >> 4, z >> 4)

def in_overworld(raw):
    """Whether a player file says its player is in the overworld."""
    name = string_value(raw, "Dimension")
    if name is not None:
        return name in ("minecraft:overworld", "overworld")
    number = int_value(raw, "Dimension")
    return number == 0

def players(world):
    """(chunks to keep, overworld logout chunks) from every player file."""
    keep, logouts = set(), set()
    folder = os.path.join(world, "playerdata")
    try:
        names = os.listdir(folder)
    except OSError:
        return keep, logouts
    for name in names:
        if not name.endswith(".dat"):
            continue
        raw = read_nbt_file(os.path.join(folder, name))
        if raw is None:
            continue
        for start in occurrences(raw, marker(9, "Pos")):
            if start + 5 + 24 <= len(raw) and raw[start] == 6:
                x, _y, z = struct.unpack_from(">ddd", raw, start + 5)
                point = (int(x) >> 4, int(z) >> 4)
                keep.add(point)
                if in_overworld(raw):
                    logouts.add(point)
            break
        x, z = int_value(raw, "SpawnX"), int_value(raw, "SpawnZ")
        if x is not None and z is not None:
            keep.add((x >> 4, z >> 4))
    return keep, logouts

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

def read_slot(handle, slot):
    if slot is None:
        return None
    offset, length, _stamp = slot
    handle.seek(offset)
    return handle.read(length)

def region_coordinates(path):
    parts = os.path.basename(path).split(".")
    return int(parts[1]), int(parts[2])

def plan_region(paths, keep_always, threshold, watch):
    """Which chunks of one region file would go, decided without writing anything.

    A companion file that is there and cannot be read makes the whole region
    unreadable: what it holds for a chunk is half of whether that chunk is empty.
    """
    region, entities, poi = paths
    region_x, region_z = region_coordinates(region)
    with open(region, "rb") as handle:
        slots = read_header(handle)
        companions = []
        for path, empty in ((entities, entities_empty), (poi, poi_empty)):
            if not os.path.exists(path):
                continue
            try:
                with open(path, "rb") as other:
                    theirs = read_header(other)
                    raws = [read_slot(other, slot) for slot in theirs]
            except (OSError, Unreadable) as error:
                raise Unreadable(os.path.basename(os.path.dirname(path)) + ": " + str(error))
            companions.append((raws, empty))

        result = {"paths": paths, "removed": set(), "chunks": 0, "finished": 0, "finishedRemoved": 0}
        for index in range(SLOTS):
            slot = slots[index]
            if slot is None:
                continue
            result["chunks"] += 1
            point = (region_x * 32 + (index % 32), region_z * 32 + (index // 32))
            empty, never_finished, ticks = chunk_verdict(read_slot(handle, slot), threshold)
            if point in watch:
                watch[point] = ticks
            if not never_finished:
                result["finished"] += 1
            if not empty or point in keep_always:
                continue
            if any(raws[index] is not None and not check(raws[index]) for raws, check in companions):
                continue
            result["removed"].add(index)
            if not never_finished:
                result["finishedRemoved"] += 1
        result["bytes"] = os.path.getsize(region)
        result["after"] = written_size(
            [(None, read_slot(handle, slots[index]), 0) for index in range(SLOTS)
             if slots[index] is not None and index not in result["removed"]]
        )
        return result

def written_size(entries):
    """How big a region file holding exactly these chunks would be."""
    total = HEADER
    for _index, raw, _stamp in entries:
        total += (len(raw) + SECTOR - 1) // SECTOR * SECTOR
    return total

def adopt_owner(temporary, original):
    """Give a rebuilt file the owner and permissions of the one it replaces.

    This runs as root. A file it writes is root's unless told otherwise, and a
    server running as somebody else then fails every save into it with
    \`AccessDeniedException\` - which is what an earlier version did. A file that
    did not exist yet takes the owner of the folder it lands in. Any failure here
    is a failure of the file: it is never moved into place with the wrong owner.
    """
    try:
        info = os.stat(original)
        mode = stat.S_IMODE(info.st_mode)
    except FileNotFoundError:
        info = os.stat(os.path.dirname(original) or ".")
        mode = stat.S_IMODE(info.st_mode) & 0o666
    if hasattr(os, "chown"):
        os.chown(temporary, info.st_uid, info.st_gid)
    os.chmod(temporary, mode)

def build_file(path, removed):
    """Write \`path\` without the slots in \`removed\` beside itself; the temporary's path."""
    temporary = path + ".polaris-new"
    places = [0] * SLOTS
    stamps = [0] * SLOTS
    with open(path, "rb") as source:
        slots = read_header(source)
        with open(temporary, "wb") as out:
            out.write(b"\\0" * HEADER)
            cursor = HEADER
            for index in range(SLOTS):
                slot = slots[index]
                if slot is None or index in removed:
                    continue
                raw = read_slot(source, slot)
                padded = (len(raw) + SECTOR - 1) // SECTOR * SECTOR
                out.write(raw)
                out.write(b"\\0" * (padded - len(raw)))
                places[index] = ((cursor // SECTOR) << 8) | (padded // SECTOR)
                stamps[index] = slot[2]
                cursor += padded
            out.seek(0)
            out.write(struct.pack(">1024I", *places))
            out.write(struct.pack(">1024I", *stamps))
            out.flush()
            os.fsync(out.fileno())
    adopt_owner(temporary, path)
    return temporary

def apply_region(plan):
    """Rewrite one region file and its companions without the planned chunks.

    Every file is built and given its owner first, then moved into place - the
    chunk file before its companions, so the worst an interruption can leave is
    entities and points of interest kept for a chunk that is gone, never a chunk
    kept without them. A companion only loses the slots its chunk file lost.
    """
    removed = plan["removed"]
    built = []
    try:
        for path in plan["paths"]:
            if not os.path.exists(path):
                continue
            with open(path, "rb") as handle:
                slots = read_header(handle)
            if not any(slots[index] is not None for index in removed):
                continue
            built.append((path, build_file(path, removed)))
    except Exception:
        for _path, temporary in built:
            try:
                os.remove(temporary)
            except OSError:
                pass
        raise
    freed = 0
    for path, temporary in built:
        before = os.path.getsize(path)
        os.replace(temporary, path)
        freed += before - os.path.getsize(path)
    return freed

def dimensions(world):
    """Every folder under this world that holds region files."""
    found = []
    for root, folders, _files in os.walk(world):
        if "region" in folders:
            found.append(root)
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

def backup_name(taken):
    """The name every Polaris backup has: the moment it was taken, in UTC."""
    return taken.strftime("%Y-%m-%dT%H-%M-%S-") + "%03d.tar.gz" % (taken.microsecond // 1000)

def tree_size(path):
    total = 0
    for root, _folders, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total

def back_up(world, changing):
    """Copy the world beside itself and prove the copy holds it, or refuse.

    Read back member by member to the end of the archive, so a copy that is
    truncated or corrupt fails here and not on the day somebody needs it. It
    must hold \`level.dat\` and every file about to change, at the size it is now.
    """
    world = os.path.abspath(world)
    parent, level = os.path.dirname(world), os.path.basename(world)
    members = [level] + [
        level + suffix for suffix in DIMENSION_SUFFIXES if os.path.isdir(os.path.join(parent, level + suffix))
    ]
    folder = os.path.join(parent, "backups")
    level_dat = os.path.join(world, "level.dat")
    if not os.path.isfile(level_dat):
        raise Refused("backup", detail="level.dat is missing")
    try:
        if not os.path.isdir(folder):
            os.makedirs(folder)
            adopt_owner_of_dir(folder, world)
        wanted = sum(tree_size(os.path.join(parent, member)) for member in members)
        free = shutil.disk_usage(folder).free
    except OSError as error:
        raise Refused("backup", detail=str(error))
    if free < wanted:
        raise Refused("room", free=free, size=wanted)

    taken = datetime.datetime.now(datetime.timezone.utc)
    name = backup_name(taken)
    while os.path.exists(os.path.join(folder, name)):
        taken += datetime.timedelta(milliseconds=1)
        name = backup_name(taken)
    final = os.path.join(folder, name)
    partial = final + ".part"
    expected = {level + "/level.dat": os.path.getsize(level_dat)}
    for path in changing:
        expected[os.path.relpath(path, parent).replace(os.sep, "/")] = os.path.getsize(path)
    try:
        with tarfile.open(partial, "w:gz") as archive:
            for member in members:
                archive.add(os.path.join(parent, member), arcname=member)
        # Opened for writing only so the flush to disk is allowed everywhere.
        with open(partial, "rb+") as handle:
            os.fsync(handle.fileno())
        files = 0
        seen = {}
        with tarfile.open(partial, "r:gz") as archive:
            for entry in archive:
                if not entry.isfile():
                    continue
                files += 1
                data = archive.extractfile(entry)
                while data.read(1 << 20):
                    pass
                seen[entry.name] = entry.size
        for path, size in expected.items():
            if seen.get(path) != size:
                raise Refused("backup", detail="the copy does not hold " + path)
        size = os.path.getsize(partial)
        if size <= 0 or files == 0:
            raise Refused("backup", detail="the copy is empty")
        adopt_owner(partial, level_dat)
        os.chmod(partial, 0o644)
        os.replace(partial, final)
    except Refused:
        remove_quietly(partial)
        raise
    except Exception as error:  # noqa: BLE001 - any failure is no copy
        remove_quietly(partial)
        raise Refused("backup", detail=str(error))
    return {"name": name, "sizeBytes": size, "files": files}

def adopt_owner_of_dir(folder, world):
    info = os.stat(world)
    if hasattr(os, "chown"):
        os.chown(folder, info.st_uid, info.st_gid)

def remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass

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
        "skipped": [],
        "backup": None,
        "refused": None
    }

    spawn = spawn_chunk(os.path.join(world, "level.dat"))
    keep_players, logouts = players(world)
    radius = max(0, args.keep_radius)

    plans = []
    refusal = None
    for dimension in dimensions(world):
        files = region_files(dimension)
        if not files:
            continue
        report["dimensions"] += 1
        centres = set(forced_chunks(dimension))
        overworld = os.path.abspath(dimension) == os.path.abspath(world)
        if overworld:
            for centre in ({spawn} if spawn else set()) | keep_players:
                for dx in range(-radius, radius + 1):
                    for dz in range(-radius, radius + 1):
                        centres.add((centre[0] + dx, centre[1] + dz))
        watch = {point: None for point in logouts} if overworld else {}
        finished, finished_removed = 0, 0
        for paths in files:
            try:
                plan = plan_region(paths, centres, args.keep_ticks, watch)
            except Exception as error:  # noqa: BLE001 - one bad file is not the run
                report["skipped"].append({"file": os.path.basename(paths[0]), "why": str(error)})
                continue
            report["regions"] += 1
            report["kept"] += plan["chunks"] - len(plan["removed"])
            report["removed"] += len(plan["removed"])
            finished += plan["finished"]
            finished_removed += plan["finishedRemoved"]
            if plan["removed"]:
                plans.append(plan)
        if refusal is None and any(ticks == 0 for ticks in watch.values()):
            refusal = {"reason": "untracked", "dimension": os.path.relpath(dimension, world)}
        if refusal is None and finished > 0 and finished_removed > finished * MAX_SHARE:
            refusal = {
                "reason": "share",
                "dimension": os.path.relpath(dimension, world),
                "share": round(finished_removed / finished, 4),
                "limit": MAX_SHARE
            }

    report["freedBytes"] = sum(plan["bytes"] - plan["after"] for plan in plans)
    if refusal is not None:
        report["refused"] = refusal
        print(json.dumps(report))
        return 0
    if args.dry_run or not plans:
        print(json.dumps(report))
        return 0

    try:
        changing = [path for plan in plans for path in plan["paths"] if os.path.exists(path)]
        report["backup"] = back_up(world, changing)
    except Refused as refused:
        report["refused"] = dict(reason=refused.reason, **refused.detail)
        report["freedBytes"] = 0
        print(json.dumps(report))
        return 0

    freed = 0
    removed = 0
    for plan in plans:
        try:
            freed += apply_region(plan)
            removed += len(plan["removed"])
        except Exception as error:  # noqa: BLE001 - one bad file is not the run
            report["skipped"].append({"file": os.path.basename(plan["paths"][0]), "why": str(error)})
            report["kept"] += len(plan["removed"])
    report["removed"] = removed
    report["freedBytes"] = freed
    print(json.dumps(report))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * The ownership repair, run through the same route as the optimizer and with its
 * arguments (`world-owner-repair.ts`). Puts the owner of `level.dat` back on chunk
 * files an earlier optimizer left owned by root, and touches nothing else.
 */
export const WORLD_OWNER_REPAIR_SCRIPT = `#!/usr/bin/env python3
"""Give a world's chunk files back to whoever owns the world.

An earlier world optimizer ran as root and moved its rebuilt region files into
place as root's, so the server - running as the owner of the world - failed every
save into them. This puts back the owner of \`level.dat\` on every \`.mca\` file
under \`region/\`, \`entities/\` and \`poi/\` that has a different one, and touches
nothing else: no other file, no permission, no file reached through a link.

Takes the optimizer's arguments so it runs through the same route; only
\`--world\` and \`--dry-run\` mean anything here.
"""

import argparse
import json
import os
import stat
import sys

FOLDERS = ("region", "entities", "poi")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--world", required=True)
    parser.add_argument("--keep-ticks", type=int, default=0)
    parser.add_argument("--keep-radius", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    world = args.world
    report = {"repair": True, "dryRun": bool(args.dry_run), "checked": 0, "fixed": 0, "failed": 0}
    try:
        owner = os.stat(os.path.join(world, "level.dat"))
    except OSError:
        report["error"] = "no level.dat"
        print(json.dumps(report))
        return 0
    uid, gid = owner.st_uid, owner.st_gid
    # A world root owns is a world whose files are already root's to write.
    if uid == 0:
        print(json.dumps(report))
        return 0
    for root, folders, files in os.walk(world):
        if os.path.basename(root) not in FOLDERS:
            continue
        folders[:] = []
        for name in files:
            if not name.endswith(".mca"):
                continue
            path = os.path.join(root, name)
            try:
                info = os.lstat(path)
            except OSError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            report["checked"] += 1
            if info.st_uid == uid and info.st_gid == gid:
                continue
            if args.dry_run:
                report["fixed"] += 1
                continue
            try:
                os.chown(path, uid, gid, follow_symlinks=False)
                report["fixed"] += 1
            except OSError:
                report["failed"] += 1
    print(json.dumps(report))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

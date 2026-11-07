// Incremental streaming for instanced detail. A block keeps the instance slots it was given while it stays near the
// focus, so moving only writes the blocks entering or leaving the radius instead of rewriting every instance in it.
// A freed slot is filled by moving the pool's last instance into it, which keeps the live instances a dense prefix
// (count stays exact) at the cost of one copy. Every write records its slot so only the touched ranges are uploaded.
// Pure bookkeeping: the caller owns the buffers and is told which slot to write or copy.

// A pool of `capacity` slots. add() returns the slot for a new instance (-1 when full); remove(slot) frees one and
// returns the slot whose instance must be copied into it (-1 when the freed slot was the last one). `owners[slot]`
// is whatever the caller passed to add(), and is moved along with the instance.
export function createSlotPool(capacity) {
  const owners = new Array(capacity);
  const dirty = new Set();
  const pool = {
    count: 0,
    capacity,
    owners,
    dirty,
    add(owner) {
      if (pool.count >= capacity) return -1;
      const slot = pool.count++;
      owners[slot] = owner;
      dirty.add(slot);
      return slot;
    },
    remove(slot) {
      const last = --pool.count;
      if (slot === last) {
        owners[last] = undefined;
        return -1;
      }
      owners[slot] = owners[last];
      owners[last] = undefined;
      dirty.add(slot);
      return last;
    }
  };
  return pool;
}

// Contiguous runs [{ start, count }] covering the dirty slots below `limit`, at most `maxRuns` of them: past that
// the closest runs are joined, since each run is a separate upload call and re-sending a few instances is cheaper.
export function dirtyRuns(dirty, limit, maxRuns = 16) {
  const slots = [];
  for (const s of dirty) if (s < limit) slots.push(s);
  if (slots.length === 0) return [];
  slots.sort((a, b) => a - b);
  const runs = [{ start: slots[0], end: slots[0] }];
  for (let i = 1; i < slots.length; i++) {
    const run = runs[runs.length - 1];
    if (slots[i] === run.end + 1) run.end = slots[i];
    else runs.push({ start: slots[i], end: slots[i] });
  }
  while (runs.length > maxRuns) {
    let best = 0;
    for (let i = 1; i < runs.length - 1; i++) {
      if (runs[i + 1].start - runs[i].end < runs[best + 1].start - runs[best].end) best = i;
    }
    runs[best].end = runs[best + 1].end;
    runs.splice(best + 1, 1);
  }
  return runs.map((r) => ({ start: r.start, count: r.end - r.start + 1 }));
}

// Which of `nearby` are new and which of `resident` (a Set, or a Map keyed by block) are gone. `nearby` keeps its
// order (closest first), so the entering list is the order to fill them in. Blocks in `partial` were cut short by a
// full pool: once a block leaves and frees slots, those still in range leave and enter again in range order, so the
// freed slots go to the closest blocks.
export function diffResident(resident, nearby, partial = null) {
  const keep = new Set(nearby);
  const leaving = [];
  for (const blk of resident.keys()) if (!keep.has(blk)) leaving.push(blk);
  const refill = leaving.length > 0 && partial && partial.size > 0;
  const entering = [];
  for (const blk of nearby) {
    if (!resident.has(blk)) entering.push(blk);
    else if (refill && partial.has(blk)) {
      leaving.push(blk);
      entering.push(blk);
    }
  }
  return { entering, leaving };
}

// Takes queued work from the front of `queue` while the running cost stays within `budget`; the first item is always
// taken so an item larger than the budget cannot stall the queue. Returns the items taken, in order.
export function takeBudget(queue, cost, budget) {
  let spent = 0;
  let n = 0;
  while (n < queue.length) {
    const c = cost(queue[n]);
    if (n > 0 && spent + c > budget) break;
    spent += c;
    n++;
  }
  return queue.splice(0, n);
}

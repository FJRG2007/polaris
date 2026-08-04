import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT_POSITION,
  EFFORT_ALIASES,
  isEffortPosition,
  offeredRungs,
  parseEffortPosition,
  resolveRung,
  rungPosition,
} from "./effort.ts";
import { getModelEffortLevels, modelAliases, resolveModelRung } from "./models.ts";

/** every alias a run can actually resolve to. */
const RUNNABLE = modelAliases.filter((a) => !a.fallback && !a.routing);

/** a sweep across the axis, including both ends and awkward interior points. */
const POSITIONS = [0, 0.01, 0.2, 0.25, 0.333, 0.5, 0.6, 0.75, 0.99, 1];

describe("a position always lands on a rung the model published", () => {
  // this is the whole safety argument. the stored value survives model changes
  // nobody made through the console - the org default cascades, the Router
  // clamps by card status, an `auto/*` tier resolves, a `--model=` flag
  // overrides, and the models-bump cron rewrites ladders. a position can't go
  // stale the way a name does, and the lookup can't invent a rung.
  for (const alias of RUNNABLE) {
    for (const useOpenRouter of [false, true]) {
      it(`${alias.slug} ${useOpenRouter ? "router" : "direct"}`, () => {
        const published = getModelEffortLevels({ slug: alias.slug, useOpenRouter });
        for (const position of POSITIONS) {
          const rung = resolveModelRung({ slug: alias.slug, position, useOpenRouter });
          if (rung === undefined) {
            expect(offeredRungs(published ?? [])).toHaveLength(0);
            continue;
          }
          expect(published).toContain(rung);
          expect(offeredRungs(published ?? [])).toContain(rung);
        }
      });
    }
  }
});

describe("out-of-range and nonsense positions still land safely", () => {
  const published = ["low", "medium", "high"];
  for (const position of [-1, -0.0001, 1.0001, 42, Number.MIN_SAFE_INTEGER]) {
    it(`${position} clamps onto the ladder`, () => {
      expect(published).toContain(resolveRung({ position, published }));
    });
  }
});

describe("rung names are opaque - a model may call them anything", () => {
  const madeUp = ["cheap", "balanced", "deep"];

  it("resolves against a vocabulary we've never seen", () => {
    expect(resolveRung({ position: 0, published: madeUp })).toBe("cheap");
    expect(resolveRung({ position: 0.5, published: madeUp })).toBe("balanced");
    expect(resolveRung({ position: 1, published: madeUp })).toBe("deep");
  });

  it("round-trips a rung through its position", () => {
    for (const rung of madeUp) {
      const position = rungPosition({ rung, published: madeUp });
      expect(position).toBeDefined();
      expect(resolveRung({ position: position as number, published: madeUp })).toBe(rung);
    }
  });

  // load-bearing under round-DOWN: if a rung's own position floored one index
  // low, picking a rung in the console would silently store the one beneath it.
  it("round-trips every published rung of every real model", () => {
    for (const alias of RUNNABLE) {
      const published = getModelEffortLevels({ slug: alias.slug, useOpenRouter: false }) ?? [];
      for (const rung of offeredRungs(published)) {
        const position = rungPosition({ rung, published });
        expect(position).toBeDefined();
        expect(resolveRung({ position: position as number, published })).toBe(rung);
      }
    }
  });

  it("a rung the model doesn't publish has no position", () => {
    expect(rungPosition({ rung: "high", published: madeUp })).toBeUndefined();
  });
});

describe("the axis behaves as specified", () => {
  const five = ["low", "medium", "high", "xhigh", "max"];
  const three = ["low", "medium", "high"];
  const two = ["high", "max"];

  it("0 is the cheapest rung and 1 the priciest, whatever they're called", () => {
    expect(resolveRung({ position: 0, published: two })).toBe("high");
    expect(resolveRung({ position: 1, published: two })).toBe("max");
  });

  it("the midpoint of a 3-rung ladder is 0.5 and lands mid on a 5-rung one", () => {
    expect(rungPosition({ rung: "medium", published: three })).toBe(0.5);
    expect(resolveRung({ position: 0.5, published: five })).toBe("high");
  });

  it("a position between two rungs always rounds down, never up", () => {
    // 0.5 across a 4-rung ladder is 1.5 - between medium and high
    expect(resolveRung({ position: 0.5, published: ["low", "medium", "high", "xhigh"] })).toBe(
      "medium"
    );
    // 0.9 across a 3-rung ladder is 1.8 - nearest is `high`, but down is the rule
    expect(resolveRung({ position: 0.9, published: three })).toBe("medium");
    // just shy of the top never reaches the top
    expect(resolveRung({ position: 0.99, published: five })).toBe("xhigh");
  });

  it("the default IS the position of `high`, so it lands there on a five-rung ladder", () => {
    expect(DEFAULT_EFFORT_POSITION).toBe(0.5);
    // the whole point: the default and a user clicking High store the same value
    expect(rungPosition({ rung: "high", published: five })).toBe(DEFAULT_EFFORT_POSITION);
    expect(resolveRung({ position: DEFAULT_EFFORT_POSITION, published: five })).toBe("high");
    expect(resolveRung({ position: DEFAULT_EFFORT_POSITION, published: three })).toBe("medium");
    // DeepSeek's floor - what every DeepSeek run got before this setting existed
    expect(resolveRung({ position: DEFAULT_EFFORT_POSITION, published: two })).toBe("high");
  });

  it("the default reaches `high` on every real model whose ladder has one", () => {
    for (const alias of RUNNABLE) {
      const published = getModelEffortLevels({ slug: alias.slug, useOpenRouter: false }) ?? [];
      const rungs = offeredRungs(published);
      if (!rungs.includes("high")) continue;
      // a ladder carrying `high` should default to it, not above it
      const landed = resolveRung({ position: DEFAULT_EFFORT_POSITION, published });
      expect(rungs.indexOf(landed as string)).toBeLessThanOrEqual(rungs.indexOf("high"));
    }
  });

  it("a ladder with no usable rungs yields nothing rather than a guess", () => {
    expect(resolveRung({ position: 0.5, published: [] })).toBeUndefined();
    expect(resolveRung({ position: 0.5, published: ["none", "minimal"] })).toBeUndefined();
  });

  it("disabling rungs are never selectable", () => {
    for (const position of POSITIONS) {
      const rung = resolveRung({ position, published: ["none", "minimal", "low", "high"] });
      expect(["low", "high"]).toContain(rung);
    }
  });
});

describe("parsing a user-supplied effort", () => {
  it("accepts the named aliases", () => {
    for (const [name, position] of Object.entries(EFFORT_ALIASES)) {
      expect(parseEffortPosition(name)).toBe(position);
      expect(parseEffortPosition(name.toUpperCase())).toBe(position);
    }
  });

  it("accepts claude-code's `med` spelling", () => {
    expect(parseEffortPosition("med")).toBe(EFFORT_ALIASES.medium);
  });

  it("accepts a bare position", () => {
    expect(parseEffortPosition("0.75")).toBe(0.75);
    expect(parseEffortPosition("0")).toBe(0);
    expect(parseEffortPosition("1")).toBe(1);
  });

  it("rejects anything else, so a typo stays visible", () => {
    for (const bad of ["", "  ", "bogus", "1.5", "-0.2", "NaN", "Infinity", "high-ish"]) {
      expect(parseEffortPosition(bad)).toBeUndefined();
    }
  });

  it("agrees with isEffortPosition", () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isEffortPosition(bad)).toBe(false);
    }
    for (const good of [0, 0.5, 1]) expect(isEffortPosition(good)).toBe(true);
  });
});

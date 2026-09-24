/**
 * The publication axis and the cache serveability policy. The
 * `isPubliclyServeable` cases are gardeneria's
 * `apps/api/tests/resource-cache-readthrough.test.ts`, unchanged in
 * semantics: all four axes, the owned inversion (#1096), the publication axis
 * (#1096 / #1121), malformed values, and AND composition.
 *
 * @module tests/publication
 */

import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { always, evaluate, notPublished, published } from "../src/filter.ts";
import {
  isNotPublishedAt,
  isPublishedAt,
  isPubliclyServeable,
  ModerationState,
  publishedFilter,
  serveablePolicy,
} from "../src/publication.ts";

const NOW = DateTime.toDate(DateTime.makeUnsafe("2026-09-18T12:00:00.000Z"));
const hourMs = 60 * 60 * 1000;
const at = (offsetMs: number) => DateTime.toDate(DateTime.makeUnsafe(NOW.getTime() + offsetMs));
const iso = (offsetMs: number) => at(offsetMs).toISOString();

describe("the publication axis", () => {
  it("published means stamped AND arrived; unpublished is its exact complement", () => {
    const cases = [
      Option.none(),
      Option.some(at(-hourMs)),
      Option.some(NOW),
      Option.some(at(hourMs)),
    ];
    expect(cases.map((stamp) => isPublishedAt(stamp, NOW))).toEqual([false, true, true, false]);
    for (const stamp of cases) {
      expect(isNotPublishedAt(stamp, NOW)).toBe(!isPublishedAt(stamp, NOW));
    }
  });

  it("publishedFilter: absent in, no predicate out; otherwise the arm that was asked for", () => {
    expect(publishedFilter("publishedAt", Option.none())).toEqual(always);
    expect(publishedFilter("publishedAt", Option.some(true))).toEqual(published("publishedAt"));
    expect(publishedFilter("publishedAt", Option.some(false))).toEqual(notPublished("publishedAt"));
  });

  it("the list arms agree with the row predicates on every stamp", () => {
    const context = { now: NOW, contains: () => false };
    for (const stamp of [Option.none<Date>(), Option.some(at(-hourMs)), Option.some(at(hourMs))]) {
      const row = { publishedAt: Option.getOrElse(stamp, () => null) };
      expect(evaluate(published("publishedAt"), row, context)).toBe(isPublishedAt(stamp, NOW));
      expect(evaluate(notPublished("publishedAt"), row, context)).toBe(
        isNotPublishedAt(stamp, NOW),
      );
    }
  });

  it("ModerationState is the three-state review axis", () => {
    expect(ModerationState.literals).toEqual(["pending", "approved", "rejected"]);
  });
});

describe("isPubliclyServeable — read-through security gate (PERF-CACHE-004)", () => {
  it("serves a public Content resource", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "public" } })).toBe(true);
  });

  it("REFUSES a private Content resource", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "private" } })).toBe(false);
  });

  it("refuses any non-'public' visibility value defensively", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "followers" } })).toBe(false);
    expect(isPubliclyServeable({ attributes: { visibility: "draft" } })).toBe(false);
    expect(isPubliclyServeable({ attributes: { visibility: "" } })).toBe(false);
    expect(isPubliclyServeable({ attributes: { visibility: null } })).toBe(false);
  });

  it("serves an entity-family resource (no visibility axis)", () => {
    expect(isPubliclyServeable({ attributes: { name: "Ada" } })).toBe(true);
  });

  it("refuses malformed / non-object cached values", () => {
    expect(isPubliclyServeable(null)).toBe(false);
    expect(isPubliclyServeable(undefined)).toBe(false);
    expect(isPubliclyServeable("a string")).toBe(false);
    expect(isPubliclyServeable(42)).toBe(false);
    expect(isPubliclyServeable({})).toBe(false);
    expect(isPubliclyServeable({ attributes: null })).toBe(false);
    expect(isPubliclyServeable({ attributes: "not-an-object" })).toBe(false);
  });
});

describe("isPubliclyServeable — the moderationState axis (CACHE-AUTH-005)", () => {
  it("REFUSES a pending comment and a rejected one; serves an approved one", () => {
    expect(isPubliclyServeable({ attributes: { moderationState: "pending" } })).toBe(false);
    expect(isPubliclyServeable({ attributes: { moderationState: "rejected" } })).toBe(false);
    expect(isPubliclyServeable({ attributes: { moderationState: "approved" } })).toBe(true);
  });

  it("refuses any non-'approved' moderationState defensively", () => {
    for (const state of ["escalated", "", null, "APPROVED"]) {
      expect(isPubliclyServeable({ attributes: { moderationState: state } })).toBe(false);
    }
  });

  it("axes compose as AND — a public visibility cannot rescue a pending comment", () => {
    expect(
      isPubliclyServeable({ attributes: { visibility: "public", moderationState: "pending" } }),
    ).toBe(false);
    expect(
      isPubliclyServeable({ attributes: { visibility: "private", moderationState: "approved" } }),
    ).toBe(false);
    expect(
      isPubliclyServeable({ attributes: { visibility: "public", moderationState: "approved" } }),
    ).toBe(true);
  });

  it("leaves resources with no moderationState axis alone", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "public", title: "A post" } })).toBe(
      true,
    );
  });
});

describe("isPubliclyServeable — the tombstone and draft axes", () => {
  it("REFUSES a resource carrying deletedAt, whatever else passes", () => {
    expect(isPubliclyServeable({ attributes: { deletedAt: "2026-08-02T00:00:00.000Z" } })).toBe(
      false,
    );
    expect(
      isPubliclyServeable({
        attributes: {
          visibility: "public",
          moderationState: "approved",
          deletedAt: "2026-08-02T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("serves a live resource, which omits deletedAt entirely", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "public" } })).toBe(true);
  });

  it("REFUSES an explicit `deletedAt: null` rather than reading it as absent", () => {
    expect(isPubliclyServeable({ attributes: { deletedAt: null } })).toBe(false);
    expect(
      isPubliclyServeable({
        attributes: { visibility: "public", moderationState: "approved", deletedAt: null },
      }),
    ).toBe(false);
  });

  it("REFUSES a draft wherever the axis is present", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "public", draft: true } })).toBe(false);
    expect(isPubliclyServeable({ attributes: { visibility: "public", draft: false } })).toBe(true);
  });
});

describe("isPubliclyServeable — the owned-family posture (#1096)", () => {
  const owned = { owned: true } as const;

  it("serves a public owned row", () => {
    expect(isPubliclyServeable({ attributes: { visibility: "public" } }, owned)).toBe(true);
  });

  for (const visibility of ["private", "followers"] as const) {
    it(`REFUSES a ${visibility} owned row`, () => {
      expect(isPubliclyServeable({ attributes: { visibility } }, owned)).toBe(false);
    });
  }

  it("REFUSES an owned row whose visibility attribute is ABSENT", () => {
    expect(isPubliclyServeable({ attributes: { name: "Ada" } }, owned)).toBe(false);
  });

  it("REFUSES an owned row whose visibility is explicitly undefined", () => {
    expect(isPubliclyServeable({ attributes: { visibility: undefined } }, owned)).toBe(false);
  });

  it("leaves reference data unchanged when the flag is absent", () => {
    expect(isPubliclyServeable({ attributes: { name: "Ada" } })).toBe(true);
    expect(isPubliclyServeable({ attributes: { name: "Ada" } }, { owned: false })).toBe(true);
  });

  it("composes as AND with the other axes", () => {
    expect(
      isPubliclyServeable({ attributes: { visibility: "public", deletedAt: "2026-01-01" } }, owned),
    ).toBe(false);
    expect(
      isPubliclyServeable(
        { attributes: { visibility: "public", moderationState: "pending" } },
        owned,
      ),
    ).toBe(false);
  });
});

describe("isPubliclyServeable — the publication axis (#1096)", () => {
  const gated = { publishGated: true, now: NOW } as const;

  it("serves a row whose stamp has arrived", () => {
    expect(isPubliclyServeable({ attributes: { publishedAt: iso(-hourMs) } }, gated)).toBe(true);
  });

  it("REFUSES an unpublished row — no stamp at all", () => {
    expect(isPubliclyServeable({ attributes: { title: "Draft" } }, gated)).toBe(false);
  });

  it("REFUSES a row scheduled for the future (#1121)", () => {
    expect(isPubliclyServeable({ attributes: { publishedAt: iso(hourMs) } }, gated)).toBe(false);
  });

  it("REFUSES an explicit null stamp rather than reading it as absent", () => {
    expect(isPubliclyServeable({ attributes: { publishedAt: null } }, gated)).toBe(false);
  });

  it("REFUSES an unparseable stamp rather than guessing", () => {
    expect(isPubliclyServeable({ attributes: { publishedAt: "not a date" } }, gated)).toBe(false);
    expect(isPubliclyServeable({ attributes: { publishedAt: 12345 } }, gated)).toBe(false);
  });

  it("accepts a Date instance as well as its JSON string form", () => {
    // Populate-on-miss gates the in-memory resource (a Date); serve-a-hit the
    // JSON-decoded one (a string). Both must agree.
    expect(isPubliclyServeable({ attributes: { publishedAt: at(-hourMs) } }, gated)).toBe(true);
    expect(isPubliclyServeable({ attributes: { publishedAt: at(hourMs) } }, gated)).toBe(false);
  });

  it("leaves families without the flag unchanged", () => {
    expect(isPubliclyServeable({ attributes: { publishedAt: iso(hourMs) } })).toBe(true);
    expect(isPubliclyServeable({ attributes: { title: "Draft" } })).toBe(true);
  });

  it("reads the wall clock when no instant is given", () => {
    const pastIso = "2000-01-01T00:00:00.000Z";
    expect(
      isPubliclyServeable({ attributes: { publishedAt: pastIso } }, { publishGated: true }),
    ).toBe(true);
  });
});

describe("serveablePolicy — the hook effect-web#4's cache takes", () => {
  it("binds a family's posture into `(resource) => boolean`", () => {
    const ownedHook = serveablePolicy({ owned: true });
    expect(ownedHook({ attributes: { visibility: "public" } })).toBe(true);
    expect(ownedHook({ attributes: { name: "Ada" } })).toBe(false);
    expect(serveablePolicy()({ attributes: { name: "Ada" } })).toBe(true);
  });
});

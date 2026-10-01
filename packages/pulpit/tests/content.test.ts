/**
 * The Content-axis field spreads' projections — the contract gardeneria's
 * `packages/models/src/models/content.ts` documents, asserted through the
 * `Resource.make` projections of a leaf built from them: `visibility` +
 * `draft` required on the resource and optional at both inputs, never
 * cleared; the timestamps in no write projection; the tombstone optional on
 * the resource and in no write projection; `owner` a required to-one linkage.
 *
 * @module tests/content
 */

import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import {
  ContentRef,
  ContentResource,
  contentVisibilityCreateFields,
  contentVisibilityResourceFields,
  makeContentResource,
  ownedContentLeafResourceFields,
  ownedVisibilityResourceFields,
  ownerRef,
  referenceLeafResourceFields,
  Visibility,
} from "../src/content.ts";
import { decodes } from "./fixtures.ts";

const UUID = "00000000-0000-4000-8000-000000000000";

/** One fixed instant for every timestamp fixture. */
const AT = DateTime.toDate(DateTime.makeUnsafe("2026-09-18T00:00:00.000Z"));

/** The application's account family, as `ownerRef` sees it. */
const UserResource = Resource.make("users", {
  attributes: { name: Schema.NonEmptyString },
});

/** An owned Content leaf: what a gardeneria `post` opens its attributes with. */
const PostResource = Resource.make("posts", {
  attributes: {
    ...ownedContentLeafResourceFields,
    ...contentVisibilityResourceFields,
    title: Schema.NonEmptyString,
  },
  relationships: { ...ownerRef(() => UserResource) },
});

/** A reference-data leaf: timestamps + tombstone, no access axis of its own. */
const TaxonResource = Resource.make("taxa", {
  attributes: { ...referenceLeafResourceFields, name: Schema.NonEmptyString },
});

describe("Visibility", () => {
  it("is the three-state axis", () => {
    expect(Visibility.literals).toEqual(["public", "followers", "private"]);
    expect(decodes(Visibility, "draft")).toBe(false);
  });
});

describe("the visibility / draft pair on an owned Content leaf", () => {
  it("is required on the resource object", () => {
    const attributes = PostResource.fields.attributes;
    expect(
      decodes(attributes, {
        createdAt: AT,
        updatedAt: AT,
        visibility: "public",
        draft: false,
        title: "A post",
      }),
    ).toBe(true);
    expect(decodes(attributes, { createdAt: AT, updatedAt: AT, title: "A post" })).toBe(false);
  });

  it("is optional at create — a DB default applies", () => {
    expect(decodes(PostResource.createInput, { title: "A post" })).toBe(true);
    expect(
      decodes(PostResource.createInput, { title: "A post", visibility: "followers", draft: true }),
    ).toBe(true);
  });

  it("is optional at update and never cleared", () => {
    expect(decodes(PostResource.updateInput, { id: UUID, title: "Renamed" })).toBe(true);
    expect(decodes(PostResource.updateInput, { id: UUID, visibility: "private" })).toBe(true);
    // `null` would clear a NOT NULL column: the descriptor is not clearable.
    expect(decodes(PostResource.updateInput, { id: UUID, visibility: null })).toBe(false);
    expect(decodes(PostResource.updateInput, { id: UUID, draft: null })).toBe(false);
  });

  it("the create-input shapes are the same pair as `Schema.optional` keys", () => {
    const Create = Schema.Struct({ ...contentVisibilityCreateFields, title: Schema.String });
    expect(decodes(Create, { title: "t" })).toBe(true);
    expect(decodes(Create, { title: "t", visibility: undefined, draft: undefined })).toBe(true);
    expect(decodes(Create, { title: "t", visibility: "hidden" })).toBe(false);
  });

  it("the owned-leaf spread carries visibility alone (a garden is not a draft of anything)", () => {
    expect(Record.keys(ownedVisibilityResourceFields)).toEqual(["visibility"]);
    expect(Record.keys(ownedContentLeafResourceFields)).toEqual([
      "createdAt",
      "updatedAt",
      "deletedAt",
      "visibility",
    ]);
  });
});

describe("the timestamps and the tombstone", () => {
  it("are on the resource object, the tombstone as an optional key", () => {
    expect(Resource.attributeKeys(TaxonResource)).toEqual([
      "createdAt",
      "updatedAt",
      "deletedAt",
      "name",
    ]);
    const live = { createdAt: AT, updatedAt: AT, name: "Quercus" };
    expect(decodes(TaxonResource.fields.attributes, live)).toBe(true);
    expect(decodes(TaxonResource.fields.attributes, { ...live, deletedAt: AT })).toBe(true);
    expect(decodes(TaxonResource.fields.attributes, { ...live, deletedAt: null })).toBe(false);
  });

  it("are in no write projection", () => {
    expect(Record.keys(TaxonResource.createInput.fields)).toEqual(["name"]);
    expect(Record.keys(TaxonResource.updateInput.fields).toSorted()).toEqual(["id", "name"]);
    expect(Record.keys(PostResource.createInput.fields)).toEqual(["visibility", "draft", "title"]);
  });
});

describe("ownerRef", () => {
  it("declares a required to-one `owner` linkage to the supplied account family", () => {
    expect(PostResource.relationships.owner.kind).toBe("one");
    expect(PostResource.relationships.owner.ref()).toBe(UserResource);
  });

  it("is required in effect-jsonapi's generated create payload (the seam a handler strips)", () => {
    // Pinned rather than hidden: the operation layer stamps the owner from the
    // viewer, so an application's hand-written create struct omits it, but
    // the generated `createPayload` lists a `one` relationship as required.
    const payload = {
      data: {
        type: "posts",
        attributes: { title: "A post" },
        relationships: { owner: { data: { type: "users", id: UUID } } },
      },
    };
    expect(decodes(PostResource.createPayload, payload)).toBe(true);
    expect(
      decodes(PostResource.createPayload, { data: { type: "posts", attributes: { title: "t" } } }),
    ).toBe(false);
  });
});

describe("the base content resource", () => {
  it("carries the timestamps and the tombstone under the auto-derived id", () => {
    expect(ContentResource.type).toBe("content");
    expect(Resource.attributeKeys(ContentResource)).toEqual([
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
    expect(decodes(ContentRef, { type: "content", id: UUID })).toBe(true);
    expect(decodes(ContentRef, { type: "posts", id: UUID })).toBe(false);
  });

  it("takes the application's own id brand", () => {
    const ContentId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ContentId"));
    const Branded = makeContentResource(ContentId);
    expect(Branded.Id).toBe(ContentId);
    expect(decodes(Branded.identifier, { type: "content", id: UUID })).toBe(true);
    expect(decodes(Branded.identifier, { type: "content", id: "not-a-uuid" })).toBe(false);
  });
});

/**
 * The wire forms (keys, nesting and value types, never the values) of WordPress
 * core's own REST responses, derived from the fixture core generates from its
 * REST API: `tests/qunit/fixtures/wp-api-generated.js` in
 * `WordPress/wordpress-develop` at `90634988698caa2f4e336830b537209e5fa01042`
 * (`PostsCollection[0]`, `PageModel`, `MediaModel`, and `PostsCollection[0]`'s
 * `_links`). A leaf is the value's `typeof` (or `"null"`); an array is the
 * form of its first element, `[]` when the fixture's is empty.
 */

export type WireForm = string | ReadonlyArray<WireForm> | { readonly [key: string]: WireForm };

export const POST_FORM: WireForm = {
  id: "number",
  date: "string",
  date_gmt: "string",
  guid: {
    rendered: "string",
  },
  modified: "string",
  modified_gmt: "string",
  slug: "string",
  status: "string",
  type: "string",
  link: "string",
  title: {
    rendered: "string",
  },
  content: {
    rendered: "string",
    protected: "boolean",
  },
  excerpt: {
    rendered: "string",
    protected: "boolean",
  },
  author: "number",
  featured_media: "number",
  comment_status: "string",
  ping_status: "string",
  sticky: "boolean",
  template: "string",
  format: "string",
  meta: {
    meta_key: "string",
  },
  categories: ["number"],
  tags: [],
  class_list: ["string"],
};

export const PAGE_FORM: WireForm = {
  id: "number",
  date: "string",
  date_gmt: "string",
  guid: {
    rendered: "string",
  },
  modified: "string",
  modified_gmt: "string",
  slug: "string",
  status: "string",
  type: "string",
  link: "string",
  title: {
    rendered: "string",
  },
  content: {
    rendered: "string",
    protected: "boolean",
  },
  excerpt: {
    rendered: "string",
    protected: "boolean",
  },
  author: "number",
  featured_media: "number",
  parent: "number",
  menu_order: "number",
  comment_status: "string",
  ping_status: "string",
  template: "string",
  meta: {
    meta_key: "string",
  },
  class_list: ["string"],
};

export const ATTACHMENT_FORM: WireForm = {
  id: "number",
  date: "string",
  date_gmt: "string",
  guid: {
    rendered: "string",
  },
  modified: "string",
  modified_gmt: "string",
  slug: "string",
  status: "string",
  type: "string",
  link: "string",
  title: {
    rendered: "string",
  },
  author: "number",
  featured_media: "number",
  comment_status: "string",
  ping_status: "string",
  template: "string",
  meta: {
    meta_key: "string",
  },
  class_list: ["string"],
  description: {
    rendered: "string",
  },
  caption: {
    rendered: "string",
  },
  alt_text: "string",
  media_type: "string",
  mime_type: "string",
  media_details: {},
  post: "null",
  source_url: "string",
  filename: "string",
  filesize: "null",
};

export const LINKS_FORM: WireForm = {
  self: [
    {
      href: "string",
      targetHints: {
        allow: ["string"],
      },
    },
  ],
  collection: [
    {
      href: "string",
    },
  ],
  about: [
    {
      href: "string",
    },
  ],
  curies: [
    {
      name: "string",
      href: "string",
      templated: "boolean",
    },
  ],
};

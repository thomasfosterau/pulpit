import * as Record from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import * as WordPress from "../src/index.ts";

describe("the package root", () => {
  // The scaffold (pulpit#115) ships no API; pulpit#86 phase 1 replaces this
  // with the real namespaces and their tests.
  it("loads and exports nothing yet", () => {
    expect(Record.keys(WordPress)).toEqual([]);
  });
});

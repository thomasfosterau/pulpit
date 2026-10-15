import * as Record from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import * as WordPress from "../src/index.ts";

describe("the package root", () => {
  // The fakes are `./testing` only, never the barrel, as in the kernel.
  it("exports each module as a namespace, and no fakes", () => {
    expect(Record.keys(WordPress)).toEqual(["Ids"]);
  });
});

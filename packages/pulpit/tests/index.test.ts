/**
 * The scaffold's smoke test: the package resolves and the test runner runs.
 * Replaced by the kernel's own suites as the slices land.
 */

import { describe, expect, it } from "vite-plus/test";
import { PULPIT } from "../src/index.ts";

describe("scaffold", () => {
  it("resolves the package", () => {
    expect(PULPIT).toBe("pulpit");
  });
});

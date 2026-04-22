import { describe, it, expect } from "vitest";
import { applyTransform } from "../src/transform.js";

describe("applyTransform", () => {
  it("returns args unchanged when transform is undefined", () => {
    const args = { a: 1, b: "x" };
    const [name, final, opts] = applyTransform(undefined, "name", args, {});
    expect(name).toBe("name");
    expect(final).toBe(args);
    expect(opts).toEqual({});
  });

  it("merges partial-object transform over args", () => {
    const args = { a: 1, b: "x" };
    const [, final] = applyTransform({ a: 99 }, "name", args, {});
    expect(final).toEqual({ a: 99, b: "x" });
  });

  it("invokes function-form transform and lets it mutate in place", () => {
    const args: { a: number; b: string } = { a: 1, b: "x" };
    let saw: { name: string } | undefined;
    const [, final] = applyTransform(
      (inner, _opts, name) => {
        inner.a = 42;
        saw = { name };
      },
      "TheName",
      args,
      {},
    );
    expect(saw?.name).toBe("TheName");
    expect(final.a).toBe(42);
    expect(final).toBe(args);
  });
});

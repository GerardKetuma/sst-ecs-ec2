import type * as pulumi from "@pulumi/pulumi";
import type { Transform } from "./types.js";

export function applyTransform<T extends object>(
  transform: Transform<T> | undefined,
  name: string,
  args: T,
  opts: pulumi.CustomResourceOptions,
): readonly [string, T, pulumi.CustomResourceOptions] {
  if (typeof transform === "function") {
    transform(args, opts, name);
    return [name, args, opts] as const;
  }
  if (transform) {
    return [name, { ...args, ...transform }, opts] as const;
  }
  return [name, args, opts] as const;
}

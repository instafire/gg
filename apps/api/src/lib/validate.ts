import type { z } from "zod";
import { unprocessable } from "./errors";

/** Structural subset of a zod schema (works for objects, pipes/transforms, etc.). */
export interface SafeParser<T> {
  safeParse: (input: unknown) =>
    | { success: true; data: T }
    | { success: false; error: z.ZodError };
}

/** Validate a request body/query; failures are RFC 9457 422s. */
export function parseBody<T>(schema: SafeParser<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw unprocessable(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}

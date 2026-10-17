import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";

import { AppError } from "../security/errors";

/** zod validator that turns failures into a consistent 400 `bad_request` body. */
export const validate = <T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const issues = result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message }));
      throw new AppError("bad_request", "Invalid request", { details: { issues } });
    }
  });

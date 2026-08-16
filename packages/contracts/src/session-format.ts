import { z } from "zod";

export const sessionFormatSchema = z.enum(["keynote", "talk", "lightning", "workshop", "panel"]);

export const SESSION_FORMAT_DURATIONS = {
  keynote: 45,
  talk: 30,
  lightning: 10,
  workshop: 120,
  panel: 45,
} as const satisfies Record<z.infer<typeof sessionFormatSchema>, number>;

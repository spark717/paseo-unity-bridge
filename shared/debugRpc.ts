import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Temporary: client-side diagnostics, written to `paseo plugin logs unity-bridge`. */
export const unityDebugRpc = defineRpc({
  name: "unity-bridge.debug",
  input: z.object({ message: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

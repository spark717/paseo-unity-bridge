import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const unityEditorStates = ["no_project", "offline", "ready", "settling", "blocked_by_dialog", "error"] as const;

export type UnityEditorState = (typeof unityEditorStates)[number];

export const unityStatusRpc = defineRpc({
  name: "unity-bridge.status",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    state: z.enum(unityEditorStates),
    projectName: z.string().nullable(),
    unityVersion: z.string().nullable(),
    port: z.number().nullable(),
    message: z.string().nullable(),
  }),
});

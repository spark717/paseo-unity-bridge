import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * - `no_project`: the workspace is not inside a Unity project.
 * - `running`: an Editor has this project open.
 * - `launching`: the plugin started an Editor for this project and it has not opened the project yet.
 * - `stopped`: no Editor has this project open.
 */
export const unityEditorProcessStates = ["no_project", "running", "launching", "stopped"] as const;

export type UnityEditorProcessState = (typeof unityEditorProcessStates)[number];

/** A workspace, or a folder for the New workspace screen, where no workspace exists yet. */
const targetInput = z.object({ workspaceId: z.string().optional(), directory: z.string().optional() });

const editorStateOutput = z.object({
  state: z.enum(unityEditorProcessStates),
  /** `m_EditorVersion` from ProjectSettings/ProjectVersion.txt. */
  editorVersion: z.string().nullable(),
  /** The installed Editor that matches `editorVersion`, or null when none was found. */
  editorPath: z.string().nullable(),
});

export const unityEditorStateRpc = defineRpc({
  name: "unity-bridge.editor-state",
  input: targetInput,
  output: editorStateOutput,
});

export const unityLaunchEditorRpc = defineRpc({
  name: "unity-bridge.launch-editor",
  input: targetInput,
  output: editorStateOutput.extend({
    ok: z.boolean(),
    message: z.string().nullable(),
  }),
});

import type { RpcOutput } from "@getpaseo/plugin";
import type { unityEditorStateRpc } from "../shared/unityEditorRpc";

type EditorState = RpcOutput<typeof unityEditorStateRpc>;

export interface LaunchPresentation {
  label: string;
  tooltip: string;
  icon: string;
  enabled: boolean;
}

/** How the launch control looks for an Editor state, or null when it should not show. */
export function describeLaunch(state: EditorState): LaunchPresentation | null {
  const version = state.editorVersion ?? "";
  const versionSuffix = version ? " " + version : "";

  if (state.state === "launching") {
    return { label: "Launching Unity…", tooltip: "Unity" + versionSuffix + " is starting", icon: "LoaderCircle", enabled: false };
  }

  if (state.state !== "stopped") {
    return null;
  }

  if (!state.editorPath) {
    return {
      label: "Unity" + versionSuffix + " not installed",
      tooltip: "Unity" + versionSuffix + " is not installed. Install it from Unity Hub.",
      icon: "Box",
      enabled: false,
    };
  }

  return { label: "Launch Unity", tooltip: "Open this project in Unity" + versionSuffix, icon: "Play", enabled: true };
}

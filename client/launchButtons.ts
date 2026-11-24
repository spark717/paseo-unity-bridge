import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { unityEditorStateRpc, unityLaunchEditorRpc } from "../shared/unityEditorRpc";

type EditorState = RpcOutput<typeof unityEditorStateRpc>;

const buttonId = "launch-unity";
const tickIntervalMs = 5_000;
/** Workspaces that are not Unity projects are checked rarely, in case one becomes one. */
const nonProjectCheckIntervalMs = 60_000;
const workspaceRefreshIntervalMs = 60_000;
const workspacePageLimit = 200;

interface TrackedWorkspace {
  lastState: EditorState | null;
  checkedAt: number;
  checking: boolean;
  launching: boolean;
  registration: PluginButtonRegistration | null;
}

/**
 * Puts a "Launch Unity" button in the header above the chat of every Unity workspace whose project
 * is not open in an Editor. The button hides once the Editor holds the project open.
 */
export function startLaunchButtons(client: PluginClientContext): () => void {
  const workspaces = new Map<string, TrackedWorkspace>();
  let stopped = false;

  const track = (workspaceId: string) => {
    if (!workspaces.has(workspaceId)) {
      workspaces.set(workspaceId, { lastState: null, checkedAt: 0, checking: false, launching: false, registration: null });
      void checkWorkspace(workspaceId);
    }
  };

  const untrack = (workspaceId: string) => {
    workspaces.get(workspaceId)?.registration?.remove();
    workspaces.delete(workspaceId);
  };

  const refreshWorkspaces = async () => {
    try {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.paseo.workspaces.list({ page: { limit: workspacePageLimit, cursor } });
        for (const workspace of page.entries) {
          seen.add(workspace.id);
          track(workspace.id);
        }
        cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor && !stopped);

      if (stopped) {
        return;
      }
      for (const workspaceId of [...workspaces.keys()]) {
        if (!seen.has(workspaceId)) {
          untrack(workspaceId);
        }
      }
    } catch {
      // The host may be offline; the next refresh tries again.
    }
  };

  const checkWorkspace = async (workspaceId: string) => {
    const tracked = workspaces.get(workspaceId);
    if (!tracked || tracked.checking || tracked.launching) {
      return;
    }
    tracked.checking = true;
    try {
      const state = await client.rpc(unityEditorStateRpc, { workspaceId });
      if (!stopped && workspaces.get(workspaceId) === tracked) {
        applyState(workspaceId, tracked, state);
      }
    } catch {
      // Keep the last known button; the next tick asks again.
    } finally {
      tracked.checking = false;
      tracked.checkedAt = Date.now();
    }
  };

  const launch = async (workspaceId: string) => {
    const tracked = workspaces.get(workspaceId);
    if (!tracked || tracked.launching) {
      return;
    }
    tracked.launching = true;
    tracked.registration?.update({ disabled: true, label: "Launching Unity…" });
    try {
      const result = await client.rpc(unityLaunchEditorRpc, { workspaceId });
      if (!result.ok) {
        throw new Error(result.message ?? "Could not launch Unity.");
      }
      applyState(workspaceId, tracked, result);
    } finally {
      tracked.launching = false;
      if (tracked.lastState) {
        applyState(workspaceId, tracked, tracked.lastState);
      }
    }
  };

  const applyState = (workspaceId: string, tracked: TrackedWorkspace, state: EditorState) => {
    tracked.lastState = state;
    const button = describeButton(state, () => launch(workspaceId));
    if (!button) {
      tracked.registration?.update({ visible: false });
      return;
    }
    if (tracked.registration) {
      tracked.registration.update(button);
    } else {
      tracked.registration = client.addHeaderButton({ id: buttonId, workspaceId, button });
    }
  };

  const tick = () => {
    const now = Date.now();
    for (const [workspaceId, tracked] of workspaces) {
      const interval = tracked.lastState?.state === "no_project" ? nonProjectCheckIntervalMs : tickIntervalMs;
      if (now - tracked.checkedAt >= interval) {
        void checkWorkspace(workspaceId);
      }
    }
  };

  const removeWorkspaceListener = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") {
      track(update.workspace.id);
    } else if (update.kind === "remove") {
      untrack(update.id);
    }
  });

  void refreshWorkspaces();
  const tickTimer = setInterval(tick, tickIntervalMs);
  const refreshTimer = setInterval(() => void refreshWorkspaces(), workspaceRefreshIntervalMs);

  return () => {
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(refreshTimer);
    removeWorkspaceListener();
    for (const tracked of workspaces.values()) {
      tracked.registration?.remove();
    }
    workspaces.clear();
  };
}

/** The button for an Editor state, or null when it should not show. */
function describeButton(state: EditorState, onPress: () => Promise<void>): PluginButton | null {
  const version = state.editorVersion ?? "";
  const versionSuffix = version ? " " + version : "";

  if (state.state === "launching") {
    return {
      title: "Unity" + versionSuffix + " is starting",
      label: "Launching Unity…",
      icon: "LoaderCircle",
      visible: true,
      disabled: true,
      behavior: { kind: "action", onPress },
    };
  }

  if (state.state !== "stopped") {
    return null;
  }

  if (!state.editorPath) {
    return {
      title: "Unity" + versionSuffix + " is not installed. Install it from Unity Hub.",
      label: "Unity" + versionSuffix + " not installed",
      icon: "Box",
      visible: true,
      disabled: true,
      behavior: { kind: "action", onPress },
    };
  }

  return {
    title: "Open this project in Unity" + versionSuffix,
    label: "Launch Unity",
    icon: "Play",
    visible: true,
    disabled: false,
    behavior: { kind: "action", onPress },
  };
}

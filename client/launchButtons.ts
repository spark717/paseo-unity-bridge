import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { unityEditorStateRpc, unityLaunchEditorRpc } from "../shared/unityEditorRpc";

type EditorState = RpcOutput<typeof unityEditorStateRpc>;

const buttonId = "launch-unity";
const tickIntervalMs = 5_000;
/** Workspaces that are not Unity projects are checked rarely, in case one becomes one. */
const nonProjectCheckIntervalMs = 60_000;
const agentRefreshIntervalMs = 60_000;
const agentPageLimit = 200;

interface TrackedWorkspace {
  lastState: EditorState | null;
  checkedAt: number;
  checking: boolean;
  launching: boolean;
  /** The button every agent of this workspace shows, or null when it is hidden. */
  button: PluginButton | null;
}

interface TrackedAgent {
  workspaceId: string;
  registration: PluginButtonRegistration | null;
}

/**
 * Puts a "Launch Unity" pill on the chat input of every agent in a Unity workspace whose project
 * is not open in an Editor. The pill hides once the Editor holds the project open.
 */
export function startLaunchButtons(client: PluginClientContext): () => void {
  const workspaces = new Map<string, TrackedWorkspace>();
  const agents = new Map<string, TrackedAgent>();
  let stopped = false;

  const trackAgent = (agentId: string, workspaceId: string) => {
    const existing = agents.get(agentId);
    if (existing?.workspaceId === workspaceId) {
      return;
    }
    if (existing) {
      untrackAgent(agentId);
    }
    const agent: TrackedAgent = { workspaceId, registration: null };
    agents.set(agentId, agent);

    const workspace = workspaces.get(workspaceId);
    if (workspace) {
      showButton(agentId, agent, workspace.button);
    } else {
      workspaces.set(workspaceId, { lastState: null, checkedAt: 0, checking: false, launching: false, button: null });
      void checkWorkspace(workspaceId);
    }
  };

  const untrackAgent = (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent) {
      return;
    }
    agent.registration?.remove();
    agents.delete(agentId);

    const workspaceStillUsed = [...agents.values()].some((other) => other.workspaceId === agent.workspaceId);
    if (!workspaceStillUsed) {
      workspaces.delete(agent.workspaceId);
    }
  };

  const showButton = (agentId: string, agent: TrackedAgent, button: PluginButton | null) => {
    if (!button) {
      agent.registration?.update({ visible: false });
      return;
    }
    if (agent.registration) {
      agent.registration.update(button);
    } else {
      agent.registration = client.addComposerPill({ id: buttonId, workspaceId: agent.workspaceId, agentId, button });
    }
  };

  const refreshAgents = async () => {
    try {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.paseo.agents.list({ scope: "active", page: { limit: agentPageLimit, cursor } });
        for (const { agent } of page.entries) {
          if (agent.workspaceId && !agent.archivedAt) {
            seen.add(agent.id);
            trackAgent(agent.id, agent.workspaceId);
          }
        }
        cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor && !stopped);

      if (stopped) {
        return;
      }
      for (const agentId of [...agents.keys()]) {
        if (!seen.has(agentId)) {
          untrackAgent(agentId);
        }
      }
    } catch {
      // The host may be offline; the next refresh tries again.
    }
  };

  const checkWorkspace = async (workspaceId: string) => {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.checking || workspace.launching) {
      return;
    }
    workspace.checking = true;
    try {
      const state = await client.rpc(unityEditorStateRpc, { workspaceId });
      if (!stopped && workspaces.get(workspaceId) === workspace) {
        applyState(workspaceId, workspace, state);
      }
    } catch {
      // Keep the last known button; the next tick asks again.
    } finally {
      workspace.checking = false;
      workspace.checkedAt = Date.now();
    }
  };

  const launch = async (workspaceId: string) => {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.launching) {
      return;
    }
    workspace.launching = true;
    if (workspace.button) {
      setWorkspaceButton(workspaceId, workspace, { ...workspace.button, disabled: true, label: "Launching Unity…" });
    }
    try {
      const result = await client.rpc(unityLaunchEditorRpc, { workspaceId });
      workspace.lastState = result;
      if (!result.ok) {
        throw new Error(result.message ?? "Could not launch Unity.");
      }
    } finally {
      workspace.launching = false;
      if (workspace.lastState) {
        applyState(workspaceId, workspace, workspace.lastState);
      }
    }
  };

  const applyState = (workspaceId: string, workspace: TrackedWorkspace, state: EditorState) => {
    workspace.lastState = state;
    setWorkspaceButton(workspaceId, workspace, describeButton(state, () => launch(workspaceId)));
  };

  const setWorkspaceButton = (workspaceId: string, workspace: TrackedWorkspace, button: PluginButton | null) => {
    workspace.button = button;
    for (const [agentId, agent] of agents) {
      if (agent.workspaceId === workspaceId) {
        showButton(agentId, agent, button);
      }
    }
  };

  const tick = () => {
    const now = Date.now();
    for (const [workspaceId, workspace] of workspaces) {
      const interval = workspace.lastState?.state === "no_project" ? nonProjectCheckIntervalMs : tickIntervalMs;
      if (now - workspace.checkedAt >= interval) {
        void checkWorkspace(workspaceId);
      }
    }
  };

  const removeAgentListener = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      untrackAgent(update.agentId);
      return;
    }
    const agent = update.agent;
    if (agent.archivedAt || !agent.workspaceId) {
      untrackAgent(agent.id);
    } else {
      trackAgent(agent.id, agent.workspaceId);
    }
  });

  void refreshAgents();
  const tickTimer = setInterval(tick, tickIntervalMs);
  const refreshTimer = setInterval(() => void refreshAgents(), agentRefreshIntervalMs);

  return () => {
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(refreshTimer);
    removeAgentListener();
    for (const agent of agents.values()) {
      agent.registration?.remove();
    }
    agents.clear();
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

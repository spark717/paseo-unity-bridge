import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginComposerItemProps } from "@getpaseo/plugin/client";
import type { ProjectRef } from "@getpaseo/plugin/client";
import { useComposer, useNewWorkspace, useProject, useProjects, useRpc } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
import type { RpcOutput } from "@getpaseo/plugin";
import { unityEditorStateRpc, unityLaunchEditorRpc } from "../shared/unityEditorRpc";
import { describeLaunch } from "./launchPresentation";

type EditorState = RpcOutput<typeof unityEditorStateRpc>;
type LaunchTarget = { workspaceId: string } | { directory: string };

const editorPollIntervalMs = 5_000;
const nonProjectPollIntervalMs = 60_000;
const routePollIntervalMs = 1_000;

/**
 * The "Launch Unity" control in composers that have no agent yet: a new chat in a workspace, and
 * the New workspace screen. Running agents get a composer pill from `launchButtons.ts` instead.
 */
export function LaunchUnityComposerItem(_props: PluginComposerItemProps) {
  const composer = useComposer();
  if (composer.context === "draft") {
    return <DraftLaunch />;
  }
  if (composer.context === "new-workspace") {
    return <NewWorkspaceLaunch />;
  }
  return null;
}

function DraftLaunch() {
  const workspaceId = useRouteWorkspaceId();
  return <LaunchAction target={workspaceId ? { workspaceId } : null} />;
}

function NewWorkspaceLaunch() {
  const newWorkspace = useNewWorkspace();
  const projectId = newWorkspace.project?.id ?? null;
  const projectRefs = useProjects();
  const projectRef = projectId ? (projectRefs.find((ref) => ref.id === projectId) ?? null) : null;
  return projectRef ? <ProjectLaunch projectRef={projectRef} /> : null;
}

function ProjectLaunch({ projectRef }: { projectRef: ProjectRef }) {
  const rootPath = useProject(projectRef, (project) => project.rootPath);
  return <LaunchAction target={rootPath ? { directory: rootPath } : null} />;
}

function LaunchAction({ target }: { target: LaunchTarget | null }) {
  const { state, refresh } = useEditorState(target);
  const launchEditor = useRpc(unityLaunchEditorRpc);

  const presentation = state ? describeLaunch(state) : null;
  if (!target || !presentation) {
    return null;
  }

  const onPress = async () => {
    try {
      const result = await launchEditor(target);
      if (!result.ok) {
        throw new Error(result.message ?? "Could not launch Unity.");
      }
    } finally {
      await refresh();
    }
  };

  return <Action title={presentation.label} icon={presentation.icon} disabled={!presentation.enabled} onPress={onPress} />;
}

/** Polls the Editor state for `target`; null until the first answer, and while there is no target. */
function useEditorState(target: LaunchTarget | null): { state: EditorState | null; refresh: () => Promise<void> } {
  const fetchState = useRpc(unityEditorStateRpc);
  const [state, setState] = useState<EditorState | null>(null);
  const targetKey = target ? JSON.stringify(target) : null;
  const latestKey = useRef(targetKey);
  latestKey.current = targetKey;
  const latestState = useRef(state);
  latestState.current = state;

  const refresh = useCallback(async () => {
    const key = latestKey.current;
    if (!key) {
      return;
    }
    try {
      const next = await fetchState(JSON.parse(key) as LaunchTarget);
      if (latestKey.current === key) {
        setState(next);
      }
    } catch {
      // The host may be offline; the next poll asks again.
    }
  }, [fetchState]);

  useEffect(() => {
    setState(null);
    if (!targetKey) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) {
        // Folders that are not Unity projects are checked rarely, in case one becomes one.
        const interval = latestState.current?.state === "no_project" ? nonProjectPollIntervalMs : editorPollIntervalMs;
        timer = setTimeout(poll, interval);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetKey, refresh]);

  return { state, refresh };
}

/**
 * Paseo does not tell composer items which workspace they are in, so this reads it from the app's
 * route, `/h/<serverId>/workspace/<workspaceId>`. Null outside a workspace screen, and on native
 * clients, which have no URL.
 */
function useRouteWorkspaceId(): string | null {
  const [workspaceId, setWorkspaceId] = useState(readRouteWorkspaceId);
  useEffect(() => {
    const timer = setInterval(() => setWorkspaceId(readRouteWorkspaceId()), routePollIntervalMs);
    return () => clearInterval(timer);
  }, []);
  return workspaceId;
}

const encodedIdPrefix = "b64_";

function readRouteWorkspaceId(): string | null {
  const location = (globalThis as { location?: { pathname?: string; hash?: string } }).location;
  // Match anywhere in the path or hash, in case the app is served under a prefix or hash routing.
  const route = (location?.pathname ?? "") + " " + (location?.hash ?? "");
  const match = /\/h\/[^/\s]+\/workspace\/([^/?#\s]+)/.exec(route);
  const segment = match?.[1];
  if (!segment) {
    return null;
  }

  const decoded = safeDecodeURIComponent(segment);
  // Ids with characters outside [A-Za-z0-9._~-] travel as "b64_" + base64url.
  if (decoded.startsWith(encodedIdPrefix)) {
    return decodeBase64Url(decoded.slice(encodedIdPrefix.length));
  }
  return decoded;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeBase64Url(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

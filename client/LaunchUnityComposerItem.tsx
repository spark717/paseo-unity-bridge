import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginComposerItemProps, PluginNewWorkspaceItemProps } from "@getpaseo/plugin/client";
import type { ProjectRef } from "@getpaseo/plugin/client";
import { useComposer, useNewWorkspace, useProject, useProjects, useRpc } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
import type { RpcOutput } from "@getpaseo/plugin";
import { unityEditorStateRpc, unityLaunchEditorRpc } from "../shared/unityEditorRpc";
import { describeLaunch } from "./launchPresentation";
import { unityDebugRpc } from "../shared/debugRpc";

/** Temporary: sends `message` to the plugin log whenever it changes. */
function useDebug(message: string) {
  const send = useRpc(unityDebugRpc);
  useEffect(() => {
    send({ message }).catch(() => undefined);
  }, [message, send]);
}

type EditorState = RpcOutput<typeof unityEditorStateRpc>;
type LaunchTarget = { workspaceId: string } | { directory: string };

const editorPollIntervalMs = 5_000;
const nonProjectPollIntervalMs = 60_000;
const routePollIntervalMs = 1_000;

/**
 * The "Launch Unity" control in a new chat inside a workspace, which has no agent yet. Running
 * agents get a composer pill from `launchButtons.ts`; the New workspace screen gets
 * `LaunchUnityNewWorkspaceItem`.
 */
export function LaunchUnityComposerItem(_props: PluginComposerItemProps) {
  const composer = useComposer();
  const route = useRoute();
  useDebug("composer item: context=" + composer.context + " route=" + JSON.stringify(route));
  if (composer.context === "draft" && route?.kind === "workspace") {
    return <LaunchAction target={{ workspaceId: route.workspaceId }} />;
  }
  return null;
}

/** The "Launch Unity" control in the New workspace setup, for the project the user picked. */
export function LaunchUnityNewWorkspaceItem(_props: PluginNewWorkspaceItemProps) {
  const newWorkspace = useNewWorkspace();
  const projectId = newWorkspace.project?.id ?? null;
  const projectRefs = useProjects();
  const projectRef = projectId ? (projectRefs.find((ref) => ref.id === projectId) ?? null) : null;
  useDebug("new workspace item: project=" + JSON.stringify(newWorkspace.project) + " found=" + Boolean(projectRef));
  return projectRef ? <ProjectLaunch projectRef={projectRef} /> : null;
}

function ProjectLaunch({ projectRef }: { projectRef: ProjectRef }) {
  const rootPath = useProject(projectRef, (project) => project.rootPath);
  useDebug("project launch: ref=" + JSON.stringify(projectRef) + " rootPath=" + rootPath);
  return <LaunchAction target={rootPath ? { directory: rootPath } : null} />;
}

function LaunchAction({ target }: { target: LaunchTarget | null }) {
  const { state, refresh } = useEditorState(target);
  useDebug("launch action: target=" + JSON.stringify(target) + " state=" + JSON.stringify(state));
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
  const targetKey = target ? JSON.stringify(target) : null;
  // The state remembers its target, so a new target never shows the previous target's state.
  const [stateEntry, setStateEntry] = useState<{ key: string; state: EditorState } | null>(null);
  const state = stateEntry && stateEntry.key === targetKey ? stateEntry.state : null;
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
        setStateEntry({ key, state: next });
      }
    } catch {
      // The host may be offline; the next poll asks again.
    }
  }, [fetchState]);

  useEffect(() => {
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
type AppRoute = { kind: "workspace"; workspaceId: string };

function useRoute(): AppRoute | null {
  const [routeKey, setRouteKey] = useState(readRouteKey);
  useEffect(() => {
    const timer = setInterval(() => setRouteKey(readRouteKey()), routePollIntervalMs);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => parseRoute(routeKey), [routeKey]);
}

function readRouteKey(): string {
  const location = (globalThis as { location?: { pathname?: string; search?: string; hash?: string } }).location;
  return (location?.pathname ?? "") + (location?.search ?? "") + (location?.hash ?? "");
}

/**
 * Reads the app route, `/h/<serverId>/workspace/<workspaceId>`.
 */
function parseRoute(routeKey: string): AppRoute | null {
  const workspaceId = readRouteWorkspaceId(routeKey);
  if (workspaceId) {
    return { kind: "workspace", workspaceId };
  }

  return null;
}

const encodedIdPrefix = "b64_";

function readRouteWorkspaceId(route: string): string | null {
  const match = /\/h\/[^/]+\/workspace\/([^/?#]+)/.exec(route);
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

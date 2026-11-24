import { useEffect, useState } from "react";
import type { PluginComposerItemProps } from "@getpaseo/plugin/client";
import { useComposer, useRpc } from "@getpaseo/plugin/client";
import { Action } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { unityEditorStateRpc, unityLaunchEditorRpc } from "../shared/unityEditorRpc";
import { describeLaunch } from "./launchPresentation";

const editorPollIntervalMs = 5_000;
const nonProjectPollIntervalMs = 60_000;
const routePollIntervalMs = 1_000;

/**
 * The "Launch Unity" control in a new chat that has no agent yet. Running agents get a composer
 * pill from `launchButtons.ts` instead, so this item renders only in draft composers.
 */
export function LaunchUnityComposerItem({ host }: PluginComposerItemProps) {
  const composer = useComposer();
  const workspaceId = useRouteWorkspaceId();
  const isDraft = composer.context === "draft";

  const fetchState = useRpc(unityEditorStateRpc);
  const launchEditor = useRpc(unityLaunchEditorRpc);
  const stateQuery = useQuery({
    queryKey: ["unity-bridge", "editor-state", host.id, workspaceId],
    queryFn: () => fetchState({ workspaceId: workspaceId ?? "" }),
    enabled: isDraft && workspaceId !== null,
    refetchInterval: (query) => (query.state.data?.state === "no_project" ? nonProjectPollIntervalMs : editorPollIntervalMs),
  });

  if (!isDraft || !workspaceId || !stateQuery.data) {
    return null;
  }

  const presentation = describeLaunch(stateQuery.data);
  if (!presentation) {
    return null;
  }

  const onPress = async () => {
    try {
      const result = await launchEditor({ workspaceId });
      if (!result.ok) {
        throw new Error(result.message ?? "Could not launch Unity.");
      }
    } finally {
      await stateQuery.refetch();
    }
  };

  return <Action title={presentation.label} icon={presentation.icon} disabled={!presentation.enabled} onPress={onPress} />;
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
  const pathname = (globalThis as { location?: { pathname?: string } }).location?.pathname;
  const match = pathname ? /^\/h\/[^/]+\/workspace\/([^/]+)\/?$/.exec(pathname) : null;
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

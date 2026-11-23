import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge, type WorkspaceRowBadgeTone } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { RpcOutput } from "@getpaseo/plugin";
import { unityStatusRpc, type UnityEditorState } from "../shared/unityStatusRpc";

type UnityStatus = RpcOutput<typeof unityStatusRpc>;

const editorPollIntervalMs = 5_000;
/** Workspaces that are not Unity projects are checked rarely, in case one becomes one. */
const nonProjectPollIntervalMs = 60_000;

const stateLabels: Record<UnityEditorState, string> = {
  no_project: "",
  offline: "Unity offline",
  ready: "Unity",
  settling: "Unity busy",
  blocked_by_dialog: "Unity dialog",
  error: "Unity error",
};

const stateTones: Record<UnityEditorState, WorkspaceRowBadgeTone> = {
  no_project: "muted",
  offline: "muted",
  ready: "success",
  settling: "warning",
  blocked_by_dialog: "warning",
  error: "danger",
};

export function UnityStatusBadge({ workspaceId, host }: PluginWorkspaceRowBadgeItemProps) {
  const fetchStatus = useRpc(unityStatusRpc);
  const statusQuery = useQuery({
    queryKey: ["unity-bridge", "status", host.id, workspaceId],
    queryFn: () => fetchStatus({ workspaceId }),
    refetchInterval: (query) => (query.state.data?.state === "no_project" ? nonProjectPollIntervalMs : editorPollIntervalMs),
  });

  const status = statusQuery.data;
  if (!status || status.state === "no_project") {
    return null;
  }

  const label = stateLabels[status.state];
  const tone = stateTones[status.state];
  const accessibilityLabel = describeStatus(status, label);
  return <WorkspaceRowBadge icon="Box" label={label} tone={tone} accessibilityLabel={accessibilityLabel} />;
}

function describeStatus(status: UnityStatus, label: string): string {
  const parts = [label];
  if (status.projectName) {
    parts.push(status.projectName);
  }
  if (status.unityVersion) {
    parts.push(status.unityVersion);
  }
  if (status.port) {
    parts.push("port " + status.port);
  }
  if (status.message && status.state !== "ready") {
    parts.push(status.message);
  }
  return parts.join(" · ");
}

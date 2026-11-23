import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UnityStatusBadge } from "./client/UnityStatusBadge";

export default function contribute(client: PluginClientContext) {
  const removeBadge = client.addWorkspaceRowBadgeItem({
    id: "unity-status",
    title: "Unity Editor status",
    icon: "Box",
    Component: UnityStatusBadge,
  });
  return removeBadge;
}

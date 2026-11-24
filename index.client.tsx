import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startLaunchButtons } from "./client/launchButtons";
import { UnityStatusBadge } from "./client/UnityStatusBadge";

export default function contribute(client: PluginClientContext) {
  const removeBadge = client.addWorkspaceRowBadgeItem({
    id: "unity-status",
    title: "Unity Editor status",
    icon: "Box",
    Component: UnityStatusBadge,
  });
  const stopLaunchButtons = startLaunchButtons(client);
  return () => {
    stopLaunchButtons();
    removeBadge();
  };
}

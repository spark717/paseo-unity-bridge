import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startLaunchButtons } from "./client/launchButtons";
import { LaunchUnityComposerItem, LaunchUnityNewWorkspaceItem } from "./client/LaunchUnityComposerItem";
import { UnityStatusBadge } from "./client/UnityStatusBadge";

export default function contribute(client: PluginClientContext) {
  const removeBadge = client.addWorkspaceRowBadgeItem({
    id: "unity-status",
    title: "Unity Editor status",
    icon: "Box",
    Component: UnityStatusBadge,
  });
  const removeComposerItem = client.addComposerItem({
    id: "launch-unity",
    Component: LaunchUnityComposerItem,
  });
  const removeNewWorkspaceItem = client.addNewWorkspaceItem({
    id: "launch-unity",
    Component: LaunchUnityNewWorkspaceItem,
  });
  const stopLaunchButtons = startLaunchButtons(client);
  return () => {
    stopLaunchButtons();
    removeNewWorkspaceItem();
    removeComposerItem();
    removeBadge();
  };
}

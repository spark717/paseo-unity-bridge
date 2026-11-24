import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startLaunchButtons } from "./client/launchButtons";
import { LaunchUnityComposerItem } from "./client/LaunchUnityComposerItem";
import { UnityStatusBadge } from "./client/UnityStatusBadge";
import { unityDebugRpc } from "./shared/debugRpc";

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
  const stopLaunchButtons = startLaunchButtons(client);
  client.rpc(unityDebugRpc, { message: "client bundle loaded" }).catch(() => undefined);
  return () => {
    stopLaunchButtons();
    removeComposerItem();
    removeBadge();
  };
}

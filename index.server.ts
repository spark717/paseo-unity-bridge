import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createUnityTools } from "./server/agentTools";
import { findUnityProjectRoot } from "./server/projectLocator";
import { getUnityEditorState, launchUnityEditor } from "./server/editorLauncher";
import { getUnityStatus } from "./server/unityStatus";
import { unityEditorStateRpc, unityLaunchEditorRpc } from "./shared/unityEditorRpc";
import { unityStatusRpc } from "./shared/unityStatusRpc";

export default function contribute(server: PluginServerContext) {
  server.handle(unityStatusRpc, getUnityStatus);
  server.handle(unityEditorStateRpc, getUnityEditorState);
  server.handle(unityLaunchEditorRpc, launchUnityEditor);

  const removeOpenHook = server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history") {
      return undefined;
    }

    const projectRoot = findUnityProjectRoot(request.cwd);
    if (!projectRoot) {
      return undefined;
    }

    const unityTools = createUnityTools(projectRoot);
    const workflowPrompt = createWorkflowPrompt(projectRoot);
    const appendSystemPrompt = [...(request.appendSystemPrompt ?? []), workflowPrompt];
    return { ...request, tools: [...request.tools, ...unityTools], appendSystemPrompt };
  });

  return removeOpenHook;
}

function createWorkflowPrompt(projectRoot: string): string {
  return [
    "This workspace is the Unity project at " + projectRoot + ".",
    "The unity_* tools drive the open Unity Editor through Unity Pipeline:",
    "check unity_status, find commands with unity_list_commands (detail='groups' first, then group= or query=),",
    "read parameters with unity_describe_command, then run with unity_exec.",
    "Use job=true with unity_job_status for builds, tests and other long work.",
  ].join(" ");
}

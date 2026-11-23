import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { unityEditorStates, type UnityEditorState, unityStatusRpc } from "../shared/unityStatusRpc";
import { PipelineClient } from "./pipelineClient";
import { findUnityProjectRoot } from "./projectLocator";

type UnityStatus = RpcOutput<typeof unityStatusRpc>;

/** Resolves a workspace to its Unity project and reports the Editor's pipeline readiness. */
export async function getUnityStatus(
  { workspaceId }: RpcInput<typeof unityStatusRpc>,
  context: PluginHandlerContext,
): Promise<UnityStatus> {
  const workspace = context.paseo.workspaces.ref(workspaceId);
  await workspace.refresh();
  const projectRoot = findUnityProjectRoot(workspace.directory);
  if (!projectRoot) {
    return createStatus("no_project", null);
  }

  const client = new PipelineClient(projectRoot);
  const response = await client.status();
  const instance = response.instance;
  const projectName = instance?.projectName ?? null;
  const unityVersion = instance?.unityVersion ?? null;
  const port = instance?.port ?? null;

  if (!response.ok) {
    // No HTTP status means nothing answered: no descriptor, or the Editor is not listening.
    const state: UnityEditorState = response.httpStatus === null ? "offline" : "error";
    return { state, projectName, unityVersion, port, message: response.error };
  }

  const reportedStatus = (response.body as { status?: string } | null)?.status;
  const state = toEditorState(reportedStatus);
  return { state, projectName, unityVersion, port, message: instance?.info ?? null };
}

function toEditorState(reportedStatus: string | undefined): UnityEditorState {
  const knownState = unityEditorStates.find((state) => state === reportedStatus);
  return knownState ?? "error";
}

function createStatus(state: UnityEditorState, message: string | null): UnityStatus {
  return { state, projectName: null, unityVersion: null, port: null, message };
}

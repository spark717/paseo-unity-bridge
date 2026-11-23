import { readFile } from "node:fs/promises";
import path from "node:path";

const descriptorRelativePath = path.join("Library", "Pipeline", ".unity-pipeline-port");

interface RawEndpoint {
  type?: string;
  port?: string;
}

interface RawDescriptor {
  pid?: number;
  port?: number;
  projectPath?: string;
  projectName?: string;
  unityVersion?: string;
  mode?: string;
  role?: string;
  instanceName?: string;
  startedAt?: string;
  lastHeartbeat?: string;
  evalToken?: string;
  info?: string;
  capabilities?: string[];
  endpoints?: RawEndpoint[];
}

/** Descriptor fields that are safe to show to agents and the UI. Never includes the token. */
export interface PipelineInstanceInfo {
  pid: number | null;
  port: number;
  projectPath: string | null;
  projectName: string | null;
  unityVersion: string | null;
  mode: string | null;
  role: string | null;
  instanceName: string | null;
  startedAt: string | null;
  lastHeartbeat: string | null;
  info: string | null;
  capabilities: string[];
}

export interface PipelineConnection {
  baseUrl: string;
  token: string;
  instance: PipelineInstanceInfo;
}

export type PipelineConnectionResult =
  | { ok: true; connection: PipelineConnection }
  | { ok: false; reason: "offline" | "error"; message: string };

/**
 * Reads the Editor's pipeline descriptor from disk. Called before every request because the
 * Editor rewrites the port and token on restart and removes the file during domain reloads.
 */
export async function readPipelineConnection(projectRoot: string): Promise<PipelineConnectionResult> {
  const descriptorPath = path.join(projectRoot, descriptorRelativePath);

  let fileText: string;
  try {
    fileText = await readFile(descriptorPath, "utf8");
  } catch {
    return {
      ok: false,
      reason: "offline",
      message:
        "Unity pipeline server is not running for this project (no Library/Pipeline/.unity-pipeline-port). " +
        "Open the project in the Unity Editor, or start the server from Window > Pipeline > Start Server. " +
        "The file is also briefly missing during script reloads; retry in a few seconds.",
    };
  }

  let descriptor: RawDescriptor;
  try {
    descriptor = JSON.parse(fileText) as RawDescriptor;
  } catch {
    return { ok: false, reason: "error", message: "Unity pipeline descriptor is not valid JSON: " + descriptorPath };
  }

  const isProcessRunning = isProcessAlive(descriptor.pid);
  if (!isProcessRunning) {
    return {
      ok: false,
      reason: "offline",
      message: "Unity pipeline descriptor is stale: Editor process " + descriptor.pid + " is not running.",
    };
  }

  const port = resolveHttpPort(descriptor);
  if (!port) {
    return { ok: false, reason: "offline", message: "Unity pipeline server has no HTTP endpoint (HTTP Service may be disabled)." };
  }

  if (!descriptor.evalToken) {
    return { ok: false, reason: "error", message: "Unity pipeline descriptor has no evalToken." };
  }

  const instance: PipelineInstanceInfo = {
    pid: descriptor.pid ?? null,
    port,
    projectPath: descriptor.projectPath ?? null,
    projectName: descriptor.projectName ?? null,
    unityVersion: descriptor.unityVersion ?? null,
    mode: descriptor.mode ?? null,
    role: descriptor.role ?? null,
    instanceName: descriptor.instanceName ?? null,
    startedAt: descriptor.startedAt ?? null,
    lastHeartbeat: descriptor.lastHeartbeat ?? null,
    info: descriptor.info ?? null,
    capabilities: descriptor.capabilities ?? [],
  };

  // The pipeline docs require 127.0.0.1: "localhost" can fail to connect on some runtimes.
  const baseUrl = "http://127.0.0.1:" + port;
  return { ok: true, connection: { baseUrl, token: descriptor.evalToken, instance } };
}

function resolveHttpPort(descriptor: RawDescriptor): number | null {
  const endpoints = descriptor.endpoints;
  if (endpoints) {
    const httpEndpoint = endpoints.find((endpoint) => endpoint.type === "http");
    const endpointPort = Number(httpEndpoint?.port);
    return endpointPort > 0 ? endpointPort : null;
  }

  // Descriptors from older package versions have no endpoints list.
  const legacyPort = descriptor.port ?? 0;
  return legacyPort > 0 ? legacyPort : null;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

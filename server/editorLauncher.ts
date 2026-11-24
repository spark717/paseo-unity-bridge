import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { UnityEditorProcessState, unityEditorStateRpc, unityLaunchEditorRpc } from "../shared/unityEditorRpc";
import { isProcessAlive } from "./pipelineDescriptor";
import { findUnityProjectRoot } from "./projectLocator";

type EditorState = RpcOutput<typeof unityEditorStateRpc>;
type LaunchResult = RpcOutput<typeof unityLaunchEditorRpc>;

/** How long a launch counts as in progress before the button may offer another one. */
const launchGracePeriodMs = 120_000;

interface PendingLaunch {
  startedAt: number;
  exited: boolean;
}

/** Launches this plugin started, by project root. */
const pendingLaunches = new Map<string, PendingLaunch>();

export async function getUnityEditorState(
  input: RpcInput<typeof unityEditorStateRpc>,
  context: PluginHandlerContext,
): Promise<EditorState> {
  const projectRoot = await resolveProjectRoot(input, context);
  if (!projectRoot) {
    return { state: "no_project", editorVersion: null, editorPath: null };
  }
  return describeProject(projectRoot);
}

export async function launchUnityEditor(
  input: RpcInput<typeof unityLaunchEditorRpc>,
  context: PluginHandlerContext,
): Promise<LaunchResult> {
  const projectRoot = await resolveProjectRoot(input, context);
  if (!projectRoot) {
    return { state: "no_project", editorVersion: null, editorPath: null, ok: false, message: "This workspace is not inside a Unity project." };
  }

  const current = await describeProject(projectRoot);
  if (current.state !== "stopped") {
    // Already open, or a launch is on its way: a second Editor would fail on the project lock.
    return { ...current, ok: true, message: null };
  }

  if (!current.editorPath) {
    const version = current.editorVersion ?? "unknown";
    return { ...current, ok: false, message: "Unity " + version + " is not installed. Install it from Unity Hub." };
  }

  const pending: PendingLaunch = { startedAt: Date.now(), exited: false };
  try {
    const child = spawn(current.editorPath, ["-projectPath", projectRoot], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => {
      pending.exited = true;
    });
    child.once("exit", () => {
      pending.exited = true;
    });
    child.unref();
  } catch (error) {
    return { ...current, ok: false, message: "Could not start Unity: " + String(error) };
  }

  pendingLaunches.set(projectRoot, pending);
  return { ...current, state: "launching", ok: true, message: null };
}

async function resolveProjectRoot(
  { workspaceId, directory }: { workspaceId?: string; directory?: string },
  context: PluginHandlerContext,
): Promise<string | null> {
  if (workspaceId) {
    const workspace = context.paseo.workspaces.ref(workspaceId);
    await workspace.refresh();
    return findUnityProjectRoot(workspace.directory);
  }
  return findUnityProjectRoot(directory);
}

async function describeProject(projectRoot: string): Promise<EditorState> {
  const editorVersion = await readEditorVersion(projectRoot);
  const editorPath = editorVersion ? await findEditorExecutable(editorVersion) : null;
  const state = await detectProcessState(projectRoot);
  return { state, editorVersion, editorPath };
}

async function detectProcessState(projectRoot: string): Promise<UnityEditorProcessState> {
  const running = (await isProjectLocked(projectRoot)) || (await hasLiveDescriptor(projectRoot));
  if (running) {
    pendingLaunches.delete(projectRoot);
    return "running";
  }

  const pending = pendingLaunches.get(projectRoot);
  if (pending && !pending.exited && Date.now() - pending.startedAt < launchGracePeriodMs) {
    return "launching";
  }
  pendingLaunches.delete(projectRoot);
  return "stopped";
}

/**
 * The Editor holds `Temp/UnityLockfile` open without sharing while it has the project open, so
 * opening it fails with EBUSY. On macOS and Linux the lock is advisory and the open succeeds;
 * the pipeline descriptor check covers those platforms.
 */
async function isProjectLocked(projectRoot: string): Promise<boolean> {
  const lockfilePath = path.join(projectRoot, "Temp", "UnityLockfile");
  try {
    const handle = await open(lockfilePath, "r+");
    await handle.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EBUSY" || code === "EPERM" || code === "EACCES";
  }
}

/** The pipeline descriptor names the Editor's pid; a live pid means that Editor still runs. */
async function hasLiveDescriptor(projectRoot: string): Promise<boolean> {
  const descriptorPath = path.join(projectRoot, "Library", "Pipeline", ".unity-pipeline-port");
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as { pid?: number };
    return typeof descriptor.pid === "number" && isProcessAlive(descriptor.pid);
  } catch {
    return false;
  }
}

async function readEditorVersion(projectRoot: string): Promise<string | null> {
  const versionPath = path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt");
  try {
    const text = await readFile(versionPath, "utf8");
    const match = /^m_EditorVersion:\s*(\S+)/m.exec(text);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Looks where Unity Hub installs Editors, then at Editors the user located in Hub by hand. */
async function findEditorExecutable(version: string): Promise<string | null> {
  const installRoots = [...defaultInstallRoots(), ...(await readHubSecondaryInstallRoots())];
  for (const installRoot of installRoots) {
    const candidate = editorExecutableIn(path.join(installRoot, version));
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const location of await readHubManualEditorLocations(version)) {
    const candidate = normalizeEditorLocation(location);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function editorExecutableIn(versionDirectory: string): string {
  if (process.platform === "win32") {
    return path.join(versionDirectory, "Editor", "Unity.exe");
  }
  if (process.platform === "darwin") {
    return path.join(versionDirectory, "Unity.app", "Contents", "MacOS", "Unity");
  }
  return path.join(versionDirectory, "Editor", "Unity");
}

/** Hub stores a manually located macOS Editor as the `.app` bundle. */
function normalizeEditorLocation(location: string): string {
  if (location.endsWith(".app")) {
    return path.join(location, "Contents", "MacOS", "Unity");
  }
  return location;
}

function defaultInstallRoots(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [path.join(programFiles, "Unity", "Hub", "Editor")];
  }
  if (process.platform === "darwin") {
    return ["/Applications/Unity/Hub/Editor"];
  }
  return [path.join(os.homedir(), "Unity", "Hub", "Editor")];
}

function hubConfigDirectory(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "UnityHub");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "UnityHub");
  }
  return path.join(os.homedir(), ".config", "UnityHub");
}

/** `secondaryInstallPath.json` holds the custom Editor install folder as a JSON string. */
async function readHubSecondaryInstallRoots(): Promise<string[]> {
  const value = await readJson(path.join(hubConfigDirectory(), "secondaryInstallPath.json"));
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

/**
 * Editors added with Hub's "Locate" button. `editors-v2.json` keeps `{ data: [{ version, location }] }`;
 * the older `editors.json` keeps `{ "<version>": { version, location } }`. `location` is a path or a list.
 */
async function readHubManualEditorLocations(version: string): Promise<string[]> {
  const locations: string[] = [];
  for (const fileName of ["editors-v2.json", "editors.json"]) {
    const value = await readJson(path.join(hubConfigDirectory(), fileName));
    const entries = collectEditorEntries(value);
    for (const entry of entries) {
      if (entry.version !== version) {
        continue;
      }
      const entryLocations = Array.isArray(entry.location) ? entry.location : [entry.location];
      for (const location of entryLocations) {
        if (typeof location === "string") {
          locations.push(location);
        }
      }
    }
  }
  return locations;
}

interface HubEditorEntry {
  version?: unknown;
  location?: unknown;
}

function collectEditorEntries(value: unknown): HubEditorEntry[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const data = (value as { data?: unknown }).data;
  const entries = Array.isArray(data) ? data : Object.values(value);
  return entries.filter((entry): entry is HubEditorEntry => Boolean(entry) && typeof entry === "object");
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

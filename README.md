# Paseo Unity Bridge

A Paseo plugin that connects agents to the Unity Editor through the [Unity Pipeline](https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package) HTTP server.

See [OVERVIEW.md](OVERVIEW.md) for what it does.

## Requirements

- Paseo 0.17.3 or later, with **Settings > Plugins > Enable plugins** turned on.
- A Unity project with `com.unity.pipeline` installed, open in the Editor, with the pipeline server running (Window > Pipeline > Start Server, on by default).

## Install

```
paseo plugin install D:\GIT\paseo-unity-bridge
```

After editing the source, run `paseo plugin reload unity-bridge`. Logs: `paseo plugin logs unity-bridge`.

## How it works

- `server/projectLocator.ts` walks up from the agent's cwd to the folder that has `ProjectSettings/ProjectVersion.txt`.
- `server/pipelineDescriptor.ts` reads `Library/Pipeline/.unity-pipeline-port` before every request, because the Editor changes the port and token on restart.
- `server/pipelineClient.ts` calls `http://127.0.0.1:<port>/api/...` with the bearer token, and retries once on 401.
- `server/agentTools.ts` defines the six `unity_*` tools. `index.server.ts` attaches them in the `agent.open.before` hook.
- `server/editorLauncher.ts` decides whether an Editor has the project open (the locked `Temp/UnityLockfile` on Windows, or a live pid in the pipeline descriptor). It finds the Editor matching `ProjectVersion.txt` in Unity Hub's install folders and starts it with `-projectPath`.
- `client/launchButtons.ts` adds a "Launch Unity" pill to the chat input of each agent in a Unity workspace and hides it while the project is open in an Editor. `client/LaunchUnityComposerItem.tsx` shows the same control in a new chat that has no agent yet; Paseo does not tell composer items their workspace, so it reads the workspace id from the app route (`/h/<host>/workspace/<id>`).
- `client/UnityStatusBadge.tsx` polls the `unity-bridge.status` RPC and shows the Editor state on the workspace row.

## Develop

```
npm install
npm run typecheck
```

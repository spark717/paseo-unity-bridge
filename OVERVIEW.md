Paseo Unity Bridge gives agents tools that run Unity Pipeline commands in the open Unity Editor.

It works with projects that have the `com.unity.pipeline` package installed. When an agent opens in a folder inside a Unity project, the plugin adds six tools to that agent:

- `unity_status` checks whether the Editor is reachable and ready.
- `unity_list_commands` lists the Editor's pipeline commands, by group, tag or search text.
- `unity_describe_command` returns one command's parameters and JSON schema.
- `unity_exec` runs a command, either synchronously or as a detached job.
- `unity_job_status` and `unity_job_cancel` follow and stop jobs.

The tool list mirrors whatever commands the Editor publishes, so new pipeline commands work without updating the plugin. A badge on each Unity workspace row shows the Editor state: ready, busy (importing, compiling or waiting on a dialog), offline or error.

The plugin reads the Editor's port and bearer token from `Library/Pipeline/.unity-pipeline-port` in the project and only connects to `127.0.0.1`. Nothing leaves the machine.

`unity_exec` can run any pipeline command, including ones that execute arbitrary C# code or delete assets. Destructive commands still need their own `confirm=true` parameter, and Paseo's agent permissions still apply.

import { defineAgentTool, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { z } from "zod";
import { PipelineClient, type PipelineResponse } from "./pipelineClient";

interface CommandEntry {
  command?: string;
  schema?: unknown;
  [key: string]: unknown;
}

/** The Unity tools for one Unity project. Each call reads the Editor's descriptor again. */
export function createUnityTools(projectRoot: string): AgentToolDefinition[] {
  const client = new PipelineClient(projectRoot);

  const statusTool = defineAgentTool({
    name: "unity_status",
    title: "Unity: Editor status",
    description:
      "Check whether the Unity Editor for this project is reachable through Unity Pipeline. " +
      "Returns the Editor instance (project, Unity version, port) and its readiness: " +
      "ready, settling (importing or compiling) or blocked_by_dialog. Call this first.",
    input: z.object({}),
    async execute(_input, context) {
      const response = await client.status(context.signal);
      const instance = response.instance ?? null;
      return toToolResult(response, { projectRoot, instance });
    },
  });

  const listCommandsTool = defineAgentTool({
    name: "unity_list_commands",
    title: "Unity: List pipeline commands",
    description:
      "List Unity Pipeline commands available in the Editor. Start with detail='groups' or detail='tags' for an index, " +
      "then list one area with group= or tag=, or search with query=. The default detail is 'compact' " +
      "(name, description, tags). Use unity_describe_command for a command's parameters.",
    input: z.object({
      query: z.string().optional().describe("Case-insensitive substring of a command's name, description or tag."),
      group: z.string().optional().describe("Group prefix, e.g. 'gameobject' or 'build' (includes subgroups)."),
      tag: z.string().optional().describe("Tag prefix, e.g. 'scenes' or 'assets/import'."),
      detail: z.enum(["compact", "full", "groups", "tags"]).optional().describe("Default 'compact'."),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    async execute(input, context) {
      const response = await client.listCommands(input, context.signal);
      return toToolResult(response);
    },
  });

  const describeCommandTool = defineAgentTool({
    name: "unity_describe_command",
    title: "Unity: Describe pipeline command",
    description:
      "Get the full metadata and JSON parameter schema of one Unity Pipeline command, " +
      "named '<group> <name>' (e.g. 'gameobject create'). Read it before calling unity_exec with structured parameters.",
    input: z.object({
      command: z.string().min(1).describe("Full command name '<group> <name>', e.g. 'scene open'."),
    }),
    async execute(input, context) {
      const response = await client.describeCommands(input.command, context.signal);
      if (!response.ok) {
        return toToolResult(response);
      }
      const commands = readCommandEntries(response.body);
      const exactMatch = commands.find((entry) => entry.command === input.command);
      if (exactMatch) {
        const readableEntry = withParsedSchema(exactMatch);
        return jsonResult(readableEntry);
      }
      const candidateNames = commands.map((entry) => entry.command);
      return jsonResult({ error: "No command named '" + input.command + "'.", similarCommands: candidateNames }, true);
    },
  });

  const execTool = defineAgentTool({
    name: "unity_exec",
    title: "Unity: Run pipeline command",
    description:
      "Run a Unity Pipeline command in the Editor. Give exactly one of: command + parameters " +
      "(structured, names from unity_describe_command), commandLine (one string, like the `unity command` CLI) or argv. " +
      "Destructive commands refuse unless their own parameter confirm=true; use dry-run=true to preview. " +
      "For long work (builds, tests, bakes) pass job=true and poll unity_job_status: a synchronous call is cut off after about 9 minutes. " +
      "A 503 reply means the Editor is busy (see busyReason); wait and retry.",
    input: z
      .object({
        command: z.string().min(1).optional().describe("Full command name '<group> <name>'."),
        parameters: z.record(z.string(), z.unknown()).optional().describe("Arguments for `command`, by parameter name."),
        commandLine: z.string().min(1).optional().describe("e.g. \"gameobject create --name Box --primitive cube\"."),
        argv: z.array(z.string()).min(1).optional().describe("Pre-split tokens, e.g. [\"scene\", \"open\", \"Assets/Main.unity\"]."),
        job: z.boolean().optional().describe("Run as a detached job and return its jobId immediately."),
        verbose: z.boolean().optional().describe("Include envelope metadata (command echo, executedAt)."),
        timeoutSeconds: z.number().positive().optional().describe("Server-side timeout. Defaults to the command's own."),
      })
      .refine(hasExactlyOneCommandForm, {
        message: "Give exactly one of command, commandLine or argv; parameters only go with command.",
      }),
    async execute(input, context) {
      const timeout = input.timeoutSeconds === undefined ? undefined : Math.round(input.timeoutSeconds * 1000);
      const response = await client.exec(
        {
          command: input.command,
          parameters: input.parameters,
          commandLine: input.commandLine,
          argv: input.argv,
          job: input.job,
          verbose: input.verbose,
          timeout,
        },
        context.signal,
      );
      return toToolResult(response);
    },
  });

  const jobStatusTool = defineAgentTool({
    name: "unity_job_status",
    title: "Unity: Job status",
    description: "Get the state, progress and (when finished) result of a job started with unity_exec job=true.",
    input: z.object({ id: z.string().min(1).describe("The jobId returned by unity_exec.") }),
    async execute(input, context) {
      const response = await client.job(input.id, context.signal);
      return toToolResult(response);
    },
  });

  const jobCancelTool = defineAgentTool({
    name: "unity_job_cancel",
    title: "Unity: Cancel job",
    description: "Cancel a queued or running job started with unity_exec job=true.",
    input: z.object({ id: z.string().min(1).describe("The jobId returned by unity_exec.") }),
    async execute(input, context) {
      const response = await client.cancelJob(input.id, context.signal);
      return toToolResult(response);
    },
  });

  return [statusTool, listCommandsTool, describeCommandTool, execTool, jobStatusTool, jobCancelTool];
}

function hasExactlyOneCommandForm(input: { command?: string; commandLine?: string; argv?: string[]; parameters?: unknown }): boolean {
  const formCount = [input.command, input.commandLine, input.argv].filter((form) => form !== undefined).length;
  const hasStrayParameters = input.parameters !== undefined && input.command === undefined;
  return formCount === 1 && !hasStrayParameters;
}

function readCommandEntries(body: unknown): CommandEntry[] {
  const commands = (body as { commands?: unknown } | null)?.commands;
  return Array.isArray(commands) ? (commands as CommandEntry[]) : [];
}

/** The server sends `schema` as a JSON string; parse it so the agent reads one JSON document. */
function withParsedSchema(entry: CommandEntry): CommandEntry {
  if (typeof entry.schema !== "string") {
    return entry;
  }
  try {
    const schema = JSON.parse(entry.schema);
    return { ...entry, schema };
  } catch {
    return entry;
  }
}

function toToolResult(response: PipelineResponse, extra?: Record<string, unknown>): AgentToolResult {
  if (response.ok) {
    return jsonResult({ ...extra, httpStatus: response.httpStatus, response: response.body });
  }
  return jsonResult({ ...extra, error: response.error, httpStatus: response.httpStatus, response: response.body }, true);
}

function jsonResult(value: unknown, isError = false): AgentToolResult {
  const text = JSON.stringify(value, null, 2);
  return { text, isError };
}

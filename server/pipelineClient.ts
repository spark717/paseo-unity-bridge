import { readPipelineConnection, type PipelineConnection, type PipelineInstanceInfo } from "./pipelineDescriptor";

const defaultRequestTimeoutMs = 15_000;
/** Paseo stops a tool call after 10 minutes, so a synchronous exec gives up a little earlier. */
const execRequestTimeoutMs = 9.5 * 60_000;

export type PipelineResponse =
  | { ok: true; httpStatus: number; body: unknown; instance: PipelineInstanceInfo }
  | { ok: false; httpStatus: number | null; error: string; body?: unknown; instance?: PipelineInstanceInfo };

export interface CommandListQuery {
  query?: string;
  tag?: string;
  group?: string;
  detail?: string;
  groupBy?: string;
  limit?: number;
  offset?: number;
}

export interface ExecRequest {
  command?: string;
  parameters?: Record<string, unknown>;
  commandLine?: string;
  argv?: string[];
  job?: boolean;
  verbose?: boolean;
  /** Server-side command timeout in milliseconds, sent as the request's top-level `timeout`. */
  timeout?: number;
}

/** HTTP client for one Unity project's Editor pipeline server. */
export class PipelineClient {
  readonly projectRoot: string;


  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  status(signal?: AbortSignal): Promise<PipelineResponse> {
    return this.request("GET", "/api/status", undefined, defaultRequestTimeoutMs, signal);
  }

  listCommands(query: CommandListQuery, signal?: AbortSignal): Promise<PipelineResponse> {
    const search = new URLSearchParams();
    appendParam(search, "detail", query.detail ?? "compact");
    appendParam(search, "query", query.query);
    appendParam(search, "tag", query.tag);
    appendParam(search, "group", query.group);
    appendParam(search, "group_by", query.groupBy);
    appendParam(search, "limit", query.limit);
    appendParam(search, "offset", query.offset);
    const queryText = search.toString();
    return this.request("GET", "/api/commands?" + queryText, undefined, defaultRequestTimeoutMs, signal);
  }

  /** Full metadata and parameter schema for the commands whose name, description or tag match. */
  describeCommands(query: string, signal?: AbortSignal): Promise<PipelineResponse> {
    const search = new URLSearchParams({ detail: "full", query });
    const queryText = search.toString();
    return this.request("GET", "/api/commands?" + queryText, undefined, defaultRequestTimeoutMs, signal);
  }

  exec(execRequest: ExecRequest, signal?: AbortSignal): Promise<PipelineResponse> {
    const isJob = execRequest.job === true;
    const timeoutMs = isJob ? defaultRequestTimeoutMs : execRequestTimeoutMs;
    return this.request("POST", "/api/exec", execRequest, timeoutMs, signal);
  }

  job(jobId: string, signal?: AbortSignal): Promise<PipelineResponse> {
    const encodedId = encodeURIComponent(jobId);
    return this.request("GET", "/api/job?id=" + encodedId, undefined, defaultRequestTimeoutMs, signal);
  }

  cancelJob(jobId: string, signal?: AbortSignal): Promise<PipelineResponse> {
    return this.request("POST", "/api/job/cancel", { id: jobId }, defaultRequestTimeoutMs, signal);
  }

  private async request(
    method: "GET" | "POST",
    route: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<PipelineResponse> {
    const firstAttempt = await this.requestOnce(method, route, body, timeoutMs, signal);
    // A 401 usually means the Editor restarted and rotated its token; the descriptor has the new one.
    const isUnauthorized = !firstAttempt.ok && firstAttempt.httpStatus === 401;
    if (!isUnauthorized) {
      return firstAttempt;
    }
    return this.requestOnce(method, route, body, timeoutMs, signal);
  }

  private async requestOnce(
    method: "GET" | "POST",
    route: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<PipelineResponse> {
    const connectionResult = await readPipelineConnection(this.projectRoot);
    if (!connectionResult.ok) {
      return { ok: false, httpStatus: null, error: connectionResult.message };
    }

    const connection = connectionResult.connection;
    const abortController = new AbortController();
    let isTimedOut = false;
    const timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      abortController.abort();
    }, timeoutMs);
    const abortFromCaller = () => abortController.abort();
    signal?.addEventListener("abort", abortFromCaller);

    let response: Response;
    let responseText: string;
    try {
      response = await fetch(connection.baseUrl + route, {
        method,
        headers: createHeaders(connection, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abortController.signal,
      });
      responseText = await response.text();
    } catch (error) {
      const message = describeFetchError(error, isTimedOut, timeoutMs, connection);
      return { ok: false, httpStatus: null, error: message, instance: connection.instance };
    } finally {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", abortFromCaller);
    }

    const responseBody = parseJsonOrText(responseText);
    if (response.ok) {
      return { ok: true, httpStatus: response.status, body: responseBody, instance: connection.instance };
    }

    const error = describeHttpError(response.status);
    return { ok: false, httpStatus: response.status, error, body: responseBody, instance: connection.instance };
  }
}

function createHeaders(connection: PipelineConnection, hasBody: boolean): Record<string, string> {
  // No Origin header: the pipeline server refuses requests that carry one.
  const headers: Record<string, string> = { Authorization: "Bearer " + connection.token };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function appendParam(search: URLSearchParams, name: string, value: string | number | undefined): void {
  if (value === undefined || value === "") {
    return;
  }
  search.set(name, String(value));
}

function parseJsonOrText(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeHttpError(httpStatus: number): string {
  switch (httpStatus) {
    case 401:
      return "Unity pipeline rejected the bearer token (401). The Editor may have just restarted; retry.";
    case 503:
      return "Unity Editor is busy (503): still importing/compiling, or blocked by a modal dialog. See busyReason and retry.";
    default:
      return "Unity pipeline returned HTTP " + httpStatus + ".";
  }
}

function describeFetchError(
  error: unknown,
  isTimeout: boolean,
  timeoutMs: number,
  connection: PipelineConnection,
): string {
  if (isTimeout) {
    const seconds = Math.round(timeoutMs / 1000);
    return "Unity pipeline request timed out after " + seconds + "s. For long work use unity_exec with job=true.";
  }
  const reason = error instanceof Error ? error.message : String(error);
  return "Could not reach Unity pipeline at " + connection.baseUrl + ": " + reason;
}

/**
 * Host-side `BacklogManagerHostInterface` backed by the JIRA Cloud REST v3 API.
 *
 * Lives entirely in the sandcastle binary's host process — distinct from the
 * in-sandbox JIRA tooling (`jira-pickup`, `jira-issue.py`, ...) shipped by the
 * `jira` backlog-manager registry entry, which the agent runs inside its
 * container. Both surfaces are intentionally additive: the in-sandbox shape is
 * unchanged by this module.
 *
 * Auth is HTTP Basic with `email:apiToken`. Comments are posted in Atlassian
 * Document Format (ADF) since v3 rejects plain-text bodies. Labels are edited
 * via the `update.labels` operations on `PUT /rest/api/3/issue/{key}` so that
 * existing labels are preserved (a full-field overwrite would clobber them).
 */

import type {
  BacklogManagerHostInterface,
  BacklogTicket,
  ListPendingOptions,
  MarkErroredArgs,
} from "./defineSandcastle.js";

export interface JiraBacklogManagerConfig {
  /** Base URL, e.g. `"https://complikey.atlassian.net"` (no trailing slash). */
  readonly baseUrl: string;
  /** Account email used as the Basic-auth username. */
  readonly email: string;
  /** API token from id.atlassian.com/manage-profile/security/api-tokens. */
  readonly apiToken: string;
  /** Project key, e.g. `"VGD"`. */
  readonly project: string;
  /** Status name treated as pending. Default `"To Do"`. */
  readonly pendingStatus?: string;
  /** When set, `listPending` requires this label on every returned ticket. */
  readonly requiredLabel?: string;
  /** Label applied to ticket-level failures. Default `"agent-error"`. */
  readonly erroredLabel?: string;
  /** Cap on `listPending` results. Default `50`. */
  readonly listLimit?: number;
  /** Inject a custom fetch (used by tests). Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_PENDING_STATUS = "To Do";
const DEFAULT_ERRORED_LABEL = "agent-error";
const DEFAULT_LIST_LIMIT = 50;

interface JiraIssueResponse {
  readonly key: string;
  readonly fields?: {
    readonly summary?: string;
    readonly description?: unknown;
    readonly labels?: readonly string[];
    readonly priority?: { readonly name?: string } | null;
    readonly created?: string;
    readonly updated?: string;
  };
}

interface JiraSearchResponse {
  readonly issues?: readonly JiraIssueResponse[];
}

const ISSUE_FIELDS = [
  "summary",
  "description",
  "labels",
  "priority",
  "created",
  "updated",
] as const;

/**
 * Walk an ADF document tree and join all `text` nodes with newlines between
 * top-level blocks. Faithful enough for surfacing in the UI; lossy on rich
 * content like tables or panels (intentional — those are rare in tickets).
 */
const adfToPlainText = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  const obj = node as { type?: string; text?: string; content?: unknown[] };

  if (obj.type === "text" && typeof obj.text === "string") return obj.text;

  const childContent = Array.isArray(obj.content) ? obj.content : [];
  const children = childContent.map(adfToPlainText).filter((s) => s.length > 0);

  // Top-level block-ish nodes get separated by a blank line; inline by nothing.
  const blockTypes = new Set([
    "doc",
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "codeBlock",
    "blockquote",
  ]);
  const sep = blockTypes.has(obj.type ?? "") ? "\n" : "";
  return children.join(sep);
};

const adfFromPlainText = (text: string): Record<string, unknown> => ({
  version: 1,
  type: "doc",
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    content: line.length === 0 ? [] : [{ type: "text", text: line }],
  })),
});

/**
 * Quote a JQL string-literal value. JQL escapes `\` and `"` inside double-
 * quoted strings.
 */
const jqlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const buildPendingJql = (opts: {
  project: string;
  pendingStatus: string;
  requiredLabel: string | undefined;
  erroredLabel: string;
  includeErrored: boolean;
}): string => {
  const clauses: string[] = [
    `project = ${opts.project}`,
    `status = ${jqlString(opts.pendingStatus)}`,
  ];
  if (opts.requiredLabel !== undefined) {
    clauses.push(`labels = ${opts.requiredLabel}`);
  }
  if (!opts.includeErrored) {
    // `labels NOT IN (X)` returns false for tickets with NO labels, so use
    // `NOT (labels = X)` which evaluates true for unlabelled tickets too.
    clauses.push(`NOT (labels = ${opts.erroredLabel})`);
  }
  return `${clauses.join(" AND ")} ORDER BY rank ASC`;
};

const issueResponseToTicket = (
  baseUrl: string,
  raw: JiraIssueResponse,
): BacklogTicket => {
  const f = raw.fields ?? {};
  return {
    id: raw.key,
    title: f.summary ?? "",
    body: adfToPlainText(f.description),
    labels: f.labels ?? [],
    url: `${baseUrl}/browse/${raw.key}`,
    priority: f.priority?.name,
    createdAt: f.created,
    updatedAt: f.updated,
  };
};

const formatErrorComment = (args: MarkErroredArgs): string => {
  const lines = [
    `🤖 sandcastle agent error: ${args.reason}`,
    "",
    "This ticket was labelled `agent-error` by autopilot and will be skipped",
    "on subsequent runs. Strip the label (or use the UI's retry affordance)",
    "to put it back into circulation.",
  ];
  if (args.comment !== undefined && args.comment.length > 0) {
    lines.push("", "---", "", args.comment);
  }
  return lines.join("\n");
};

const RETRY_COMMENT =
  "🤖 sandcastle: `agent-error` label stripped — ticket retried.";

export const createJiraBacklogManager = (
  config: JiraBacklogManagerConfig,
): BacklogManagerHostInterface => {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const pendingStatus = config.pendingStatus ?? DEFAULT_PENDING_STATUS;
  const erroredLabel = config.erroredLabel ?? DEFAULT_ERRORED_LABEL;
  const listLimit = config.listLimit ?? DEFAULT_LIST_LIMIT;
  const doFetch: typeof fetch = config.fetch ?? globalThis.fetch;

  const authHeader =
    "Basic " +
    Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");

  const baseHeaders: Record<string, string> = {
    Authorization: authHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: baseHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `JIRA ${method} ${path} failed: ${res.status} ${res.statusText}` +
          (text.length > 0 ? ` — ${text}` : ""),
      );
    }
    return res;
  };

  const editLabel = async (id: string, op: "add" | "remove"): Promise<void> => {
    await request("PUT", `/rest/api/3/issue/${encodeURIComponent(id)}`, {
      update: { labels: [{ [op]: erroredLabel }] },
    });
  };

  const postComment = async (id: string, text: string): Promise<void> => {
    await request(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
      { body: adfFromPlainText(text) },
    );
  };

  const getLabels = async (id: string): Promise<readonly string[]> => {
    const res = await request(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(id)}?fields=labels`,
    );
    const body = (await res.json()) as JiraIssueResponse;
    return body.fields?.labels ?? [];
  };

  return {
    async listPending(
      options?: ListPendingOptions,
    ): Promise<readonly BacklogTicket[]> {
      const jql = buildPendingJql({
        project: config.project,
        pendingStatus,
        requiredLabel: config.requiredLabel,
        erroredLabel,
        includeErrored: options?.includeErrored ?? false,
      });

      const res = await request("POST", "/rest/api/3/search/jql", {
        jql,
        fields: ISSUE_FIELDS,
        maxResults: listLimit,
      });
      const body = (await res.json()) as JiraSearchResponse;
      return (body.issues ?? []).map((issue) =>
        issueResponseToTicket(baseUrl, issue),
      );
    },

    async getTicket(id: string): Promise<BacklogTicket> {
      const res = await request(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(id)}` +
          `?fields=${ISSUE_FIELDS.join(",")}`,
      );
      const body = (await res.json()) as JiraIssueResponse;
      return issueResponseToTicket(baseUrl, body);
    },

    async markErrored(args: MarkErroredArgs): Promise<void> {
      // Idempotency: only add the label if it isn't already there. Two
      // concurrent autopilot runs both calling markErrored on the same ticket
      // would otherwise race; this keeps the JQL `NOT (labels = X)` filter
      // honest by avoiding duplicate label requests.
      const labels = await getLabels(args.id);
      if (!labels.includes(erroredLabel)) {
        await editLabel(args.id, "add");
      }
      await postComment(args.id, formatErrorComment(args));
    },

    async clearErrored(id: string): Promise<void> {
      const labels = await getLabels(id);
      if (labels.includes(erroredLabel)) {
        await editLabel(id, "remove");
      }
      await postComment(id, RETRY_COMMENT);
    },
  };
};

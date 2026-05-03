/**
 * `JiraBacklogManager` tested via an HTTP-level fake `fetch` that backs onto
 * an in-memory issue store. Same store is used to satisfy the contract
 * fixture and to make JIRA-specific assertions on URL / method / payload
 * shapes.
 */

import { describe, expect, it } from "vitest";

import {
  runBacklogManagerHostInterfaceContract,
  type ContractFixture,
  type SeedTicket,
} from "./BacklogManagerHostInterface.contract.js";
import { createJiraBacklogManager } from "./JiraBacklogManager.js";

// ---------------------------------------------------------------------------
// Fake JIRA backend
// ---------------------------------------------------------------------------

interface FakeIssue {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    labels: string[];
    priority: { name: string } | null;
    status: { name: string };
    created: string;
    updated: string;
  };
  comments: string[];
}

interface FakeJiraOptions {
  readonly baseUrl?: string;
  readonly project?: string;
  readonly pendingStatus?: string;
}

interface CallRecord {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

class FakeJira {
  readonly baseUrl: string;
  readonly project: string;
  readonly pendingStatus: string;
  readonly issues = new Map<string, FakeIssue>();
  readonly calls: CallRecord[] = [];
  /**
   * Tracks status writes so the contract test can assert no transitions are
   * issued during markErrored. Bumped only when a transition or status PUT
   * touches the issue.
   */
  statusWrites = 0;

  constructor(opts: FakeJiraOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://test.atlassian.net";
    this.project = opts.project ?? "VGD";
    this.pendingStatus = opts.pendingStatus ?? "To Do";
  }

  seed(tickets: readonly SeedTicket[]): void {
    this.issues.clear();
    this.calls.length = 0;
    this.statusWrites = 0;
    const now = "2026-05-03T12:00:00.000Z";
    for (const t of tickets) {
      this.issues.set(t.id, {
        key: t.id,
        fields: {
          summary: t.title,
          description:
            t.body === undefined
              ? null
              : {
                  version: 1,
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: t.body }],
                    },
                  ],
                },
          labels: [...(t.labels ?? [])],
          priority: t.priority === undefined ? null : { name: t.priority },
          status: { name: this.pendingStatus },
          created: now,
          updated: now,
        },
        comments: [],
      });
    }
  }

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (!url.startsWith(this.baseUrl)) {
      return jsonResponse(404, { errorMessages: ["wrong host"] });
    }
    const path = url.slice(this.baseUrl.length);

    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    this.calls.push({ method, path, body: parsedBody });

    // POST /rest/api/3/search/jql
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      const body = parsedBody as { jql?: string; maxResults?: number };
      const issues = this.runJql(body.jql ?? "").slice(
        0,
        body.maxResults ?? 50,
      );
      return jsonResponse(200, { issues });
    }

    // GET /rest/api/3/issue/{key}?fields=...
    const issueGetMatch = /^\/rest\/api\/3\/issue\/([^/?]+)(?:\?.*)?$/.exec(
      path,
    );
    if (method === "GET" && issueGetMatch) {
      const key = decodeURIComponent(issueGetMatch[1]!);
      const issue = this.issues.get(key);
      if (issue === undefined) {
        return jsonResponse(404, { errorMessages: [`Not found: ${key}`] });
      }
      return jsonResponse(200, { key: issue.key, fields: issue.fields });
    }

    // PUT /rest/api/3/issue/{key}
    const issuePutMatch = /^\/rest\/api\/3\/issue\/([^/?]+)$/.exec(path);
    if (method === "PUT" && issuePutMatch) {
      const key = decodeURIComponent(issuePutMatch[1]!);
      const issue = this.issues.get(key);
      if (issue === undefined) {
        return jsonResponse(404, { errorMessages: [`Not found: ${key}`] });
      }
      const body = parsedBody as {
        fields?: { status?: unknown };
        update?: {
          labels?: { add?: string; remove?: string }[];
          status?: unknown;
        };
      };
      if (
        body.fields?.status !== undefined ||
        body.update?.status !== undefined
      ) {
        this.statusWrites++;
      }
      for (const op of body.update?.labels ?? []) {
        if (op.add !== undefined && !issue.fields.labels.includes(op.add)) {
          issue.fields.labels.push(op.add);
        }
        if (op.remove !== undefined) {
          issue.fields.labels = issue.fields.labels.filter(
            (l) => l !== op.remove,
          );
        }
      }
      return new Response(null, { status: 204 });
    }

    // POST /rest/api/3/issue/{key}/comment
    const commentMatch = /^\/rest\/api\/3\/issue\/([^/?]+)\/comment$/.exec(
      path,
    );
    if (method === "POST" && commentMatch) {
      const key = decodeURIComponent(commentMatch[1]!);
      const issue = this.issues.get(key);
      if (issue === undefined) {
        return jsonResponse(404, { errorMessages: [`Not found: ${key}`] });
      }
      const body = parsedBody as { body?: unknown };
      issue.comments.push(stringifyAdf(body.body));
      return jsonResponse(201, { id: String(issue.comments.length) });
    }

    // POST /rest/api/3/issue/{key}/transitions — surface as a status write.
    if (
      method === "POST" &&
      /^\/rest\/api\/3\/issue\/[^/?]+\/transitions$/.test(path)
    ) {
      this.statusWrites++;
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, {
      errorMessages: [`unhandled: ${method} ${path}`],
    });
  };

  /**
   * Tiny JQL evaluator — supports just the clauses `JiraBacklogManager`
   * actually emits: `project = X`, `status = "..."`, `labels = X`,
   * `NOT (labels = X)`, joined by `AND`, optional `ORDER BY`.
   */
  private runJql(
    jql: string,
  ): readonly { key: string; fields: FakeIssue["fields"] }[] {
    const trimmed = jql.replace(/\s+ORDER BY[\s\S]*$/i, "").trim();
    const clauses = splitTopLevelAnd(trimmed);

    const matches = (issue: FakeIssue): boolean => {
      for (const clause of clauses) {
        if (!evalClause(clause, issue, this.project)) return false;
      }
      return true;
    };

    return Array.from(this.issues.values())
      .filter(matches)
      .map((i) => ({ key: i.key, fields: i.fields }));
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const stringifyAdf = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  const obj = node as { type?: string; text?: string; content?: unknown[] };
  if (obj.type === "text" && typeof obj.text === "string") return obj.text;
  const children = (obj.content ?? [])
    .map(stringifyAdf)
    .filter((s) => s.length > 0);
  return children.join("\n");
};

const splitTopLevelAnd = (s: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      buf += ch;
      if (ch === '"' && s[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && /^\s+AND\s+/i.test(s.slice(i))) {
      parts.push(buf.trim());
      buf = "";
      i += " AND ".length - 1;
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) parts.push(buf.trim());
  return parts;
};

const stripParens = (s: string): { negated: boolean; inner: string } => {
  const t = s.trim();
  const notMatch = /^NOT\s+\((.*)\)$/i.exec(t);
  if (notMatch) return { negated: true, inner: notMatch[1]!.trim() };
  return { negated: false, inner: t };
};

const evalClause = (
  clauseRaw: string,
  issue: FakeIssue,
  project: string,
): boolean => {
  const { negated, inner } = stripParens(clauseRaw);
  const result = evalAtom(inner, issue, project);
  return negated ? !result : result;
};

const evalAtom = (atom: string, issue: FakeIssue, project: string): boolean => {
  const eq = /^(\w+)\s*=\s*(.+)$/.exec(atom.trim());
  if (!eq) return true;
  const field = eq[1]!.toLowerCase();
  const rawValue = eq[2]!.trim();
  const value =
    rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : rawValue;

  switch (field) {
    case "project":
      return value === project;
    case "status":
      return issue.fields.status.name === value;
    case "labels":
      return issue.fields.labels.includes(value);
    default:
      return true;
  }
};

// ---------------------------------------------------------------------------
// Run the contract suite against the JIRA implementation
// ---------------------------------------------------------------------------

const setupContractFixture = (): ContractFixture => {
  const fake = new FakeJira();
  const manager = createJiraBacklogManager({
    baseUrl: fake.baseUrl,
    email: "agent@test.example",
    apiToken: "secret-token",
    project: fake.project,
    pendingStatus: fake.pendingStatus,
    fetch: fake.fetch,
  });

  return {
    manager,
    seed: (tickets) => fake.seed(tickets),
    getComments: (id) => fake.issues.get(id)?.comments ?? [],
    getLabels: (id) => fake.issues.get(id)?.fields.labels ?? [],
    statusChangedDuringErrorFlow: () => fake.statusWrites > 0,
  };
};

runBacklogManagerHostInterfaceContract(
  "JiraBacklogManager",
  setupContractFixture,
);

// ---------------------------------------------------------------------------
// JIRA-specific behaviour
// ---------------------------------------------------------------------------

describe("JiraBacklogManager — JIRA-specific behaviour", () => {
  it("authenticates with HTTP Basic email:apiToken", async () => {
    const fake = new FakeJira();
    fake.seed([{ id: "VGD-1", title: "First" }]);

    let captured: Record<string, string> | undefined;
    const spyFetch: typeof fetch = (input, init) => {
      captured = init?.headers as Record<string, string> | undefined;
      return fake.fetch(input, init);
    };

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "alice@example.com",
      apiToken: "tok-123",
      project: fake.project,
      fetch: spyFetch,
    });

    await manager.listPending();

    const want =
      "Basic " + Buffer.from("alice@example.com:tok-123").toString("base64");
    expect(captured?.Authorization).toBe(want);
  });

  it("listPending issues a JQL search scoped to project + status, excluding errored", async () => {
    const fake = new FakeJira();
    fake.seed([{ id: "VGD-1", title: "First" }]);

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      fetch: fake.fetch,
    });

    await manager.listPending();

    const search = fake.calls.find(
      (c) => c.method === "POST" && c.path === "/rest/api/3/search/jql",
    );
    expect(search).toBeDefined();
    const body = search!.body as { jql: string; fields: string[] };
    expect(body.jql).toContain("project = VGD");
    expect(body.jql).toContain('status = "To Do"');
    expect(body.jql).toContain("NOT (labels = agent-error)");
    expect(body.fields).toContain("summary");
    expect(body.fields).toContain("description");
    expect(body.fields).toContain("priority");
  });

  it("listPending applies requiredLabel when configured", async () => {
    const fake = new FakeJira();
    fake.seed([
      { id: "VGD-1", title: "Has label", labels: ["autonomous"] },
      { id: "VGD-2", title: "No label" },
    ]);

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      requiredLabel: "autonomous",
      fetch: fake.fetch,
    });

    const tickets = await manager.listPending();
    expect(tickets.map((t) => t.id)).toEqual(["VGD-1"]);
  });

  it("getTicket returns ADF-flattened body, priority, and a /browse URL", async () => {
    const fake = new FakeJira();
    fake.seed([
      {
        id: "VGD-7",
        title: "Pin BacklogManagerHostInterface",
        body: "Two paragraphs.",
        labels: ["backend"],
        priority: "Medium",
      },
    ]);

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      fetch: fake.fetch,
    });

    const ticket = await manager.getTicket("VGD-7");
    expect(ticket.id).toBe("VGD-7");
    expect(ticket.title).toBe("Pin BacklogManagerHostInterface");
    expect(ticket.body).toContain("Two paragraphs.");
    expect(ticket.labels).toEqual(["backend"]);
    expect(ticket.priority).toBe("Medium");
    expect(ticket.url).toBe(`${fake.baseUrl}/browse/VGD-7`);
  });

  it("markErrored uses update.labels (not field overwrite) and posts ADF comment", async () => {
    const fake = new FakeJira();
    fake.seed([
      { id: "VGD-1", title: "Healthy", labels: ["backend", "needs-triage"] },
    ]);

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      fetch: fake.fetch,
    });

    await manager.markErrored({
      id: "VGD-1",
      reason: "max iterations exceeded",
      comment: "ran out at iteration 30",
    });

    expect(fake.issues.get("VGD-1")!.fields.labels.sort()).toEqual([
      "agent-error",
      "backend",
      "needs-triage",
    ]);

    const labelPut = fake.calls.find(
      (c) => c.method === "PUT" && c.path === "/rest/api/3/issue/VGD-1",
    );
    expect(labelPut).toBeDefined();
    expect(labelPut!.body).toEqual({
      update: { labels: [{ add: "agent-error" }] },
    });

    const commentPost = fake.calls.find(
      (c) =>
        c.method === "POST" && c.path === "/rest/api/3/issue/VGD-1/comment",
    );
    expect(commentPost).toBeDefined();
    const commentBody = commentPost!.body as { body: { type: string } };
    expect(commentBody.body.type).toBe("doc");
  });

  it("clearErrored uses update.labels remove (preserving siblings)", async () => {
    const fake = new FakeJira();
    fake.seed([
      { id: "VGD-1", title: "Errored", labels: ["agent-error", "backend"] },
    ]);

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      fetch: fake.fetch,
    });

    await manager.clearErrored("VGD-1");

    expect(fake.issues.get("VGD-1")!.fields.labels).toEqual(["backend"]);

    const labelPut = fake.calls.find(
      (c) => c.method === "PUT" && c.path === "/rest/api/3/issue/VGD-1",
    );
    expect(labelPut!.body).toEqual({
      update: { labels: [{ remove: "agent-error" }] },
    });
  });

  it("trims a trailing slash on baseUrl", async () => {
    const fake = new FakeJira();
    fake.seed([{ id: "VGD-1", title: "First" }]);

    const manager = createJiraBacklogManager({
      baseUrl: `${fake.baseUrl}/`,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      fetch: fake.fetch,
    });

    const tickets = await manager.listPending();
    expect(tickets[0]?.url).toBe(`${fake.baseUrl}/browse/VGD-1`);
  });

  it("surfaces non-2xx responses as Errors with status in the message", async () => {
    const fake = new FakeJira();
    fake.seed([]);

    const manager = createJiraBacklogManager({
      baseUrl: fake.baseUrl,
      email: "a@b",
      apiToken: "t",
      project: "VGD",
      fetch: fake.fetch,
    });

    await expect(manager.getTicket("VGD-MISSING")).rejects.toThrow(/404/);
  });
});

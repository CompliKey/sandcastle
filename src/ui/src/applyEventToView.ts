/**
 * Pure SessionView reducer for the live WS feed.
 *
 * The frontend receives a `snapshot` once and then a stream of events; this
 * reducer applies one event on top of a view and returns the updated view.
 * Mirrors the semantics of `SessionIndex.add` on the backend — keep them in
 * lockstep when the event union changes.
 */

import type {
  IterationUsage,
  SandcastleEvent,
  SessionIterationView,
  SessionView,
} from "./api.js";

const emptyTokens = (): SessionView["rollup"]["totalTokens"] => ({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
});

const addUsage = (
  totals: SessionView["rollup"]["totalTokens"],
  usage: IterationUsage,
): SessionView["rollup"]["totalTokens"] => ({
  input: totals.input + usage.inputTokens,
  output: totals.output + usage.outputTokens,
  cacheCreation: totals.cacheCreation + usage.cacheCreationInputTokens,
  cacheRead: totals.cacheRead + usage.cacheReadInputTokens,
});

const upsertIteration = (
  view: SessionView,
  iteration: number,
  patch: (it: SessionIterationView) => SessionIterationView,
): SessionView => {
  const idx = view.iterations.findIndex((it) => it.iteration === iteration);
  let next: SessionIterationView[];
  if (idx === -1) {
    const seed: SessionIterationView = {
      iteration,
      toolCalls: [],
      texts: [],
      userLogs: [],
    };
    next = [...view.iterations, patch(seed)];
  } else {
    const current = view.iterations[idx]!;
    next = view.iterations.slice();
    next[idx] = patch(current);
  }
  return {
    ...view,
    iterations: next,
    rollup: { ...view.rollup, iterationCount: next.length },
  };
};

export const applyEventToView = (
  view: SessionView,
  event: SandcastleEvent,
): SessionView => {
  if ("sessionId" in event && event.sessionId !== view.sessionId) {
    return view;
  }

  switch (event.type) {
    case "session.start":
      // Snapshot already covers session.start; skip if it arrives via stream.
      return view;
    case "session.end": {
      return {
        ...view,
        endedAt: event.endedAt,
        outcome: event.outcome,
        rollup: {
          ...view.rollup,
          wallTimeMs: event.endedAt - view.startedAt,
        },
      };
    }
    case "iteration.start":
      return upsertIteration(view, event.iteration, (it) => ({
        ...it,
        startedAt: event.startedAt,
      }));
    case "iteration.end":
      return rollupTokens(
        upsertIteration(view, event.iteration, (it) => ({
          ...it,
          endedAt: event.endedAt,
          usage: event.usage ?? it.usage,
        })),
      );
    case "agent.text":
      return upsertIteration(view, event.iteration, (it) => ({
        ...it,
        texts: [...it.texts, { text: event.text, timestamp: event.timestamp }],
      }));
    case "agent.toolCall":
      return upsertIteration(view, event.iteration, (it) => ({
        ...it,
        toolCalls: [
          ...it.toolCalls,
          {
            toolName: event.toolName,
            formattedArgs: event.formattedArgs,
            timestamp: event.timestamp,
          },
        ],
      }));
    case "user.log": {
      // Bucket user.log under the most recent iteration, matching backend.
      const last = view.iterations[view.iterations.length - 1];
      const targetIter = last ? last.iteration : 0;
      return upsertIteration(view, targetIter, (it) => ({
        ...it,
        userLogs: [
          ...it.userLogs,
          { payload: event.payload, timestamp: event.timestamp },
        ],
      }));
    }
    case "commit":
      return {
        ...view,
        commits: [
          ...view.commits,
          { sha: event.sha, timestamp: event.timestamp },
        ],
      };
    case "error":
      return {
        ...view,
        errors: [
          ...view.errors,
          {
            kind: event.kind,
            reason: event.reason,
            timestamp: event.timestamp,
          },
        ],
      };
  }
};

const rollupTokens = (view: SessionView): SessionView => {
  let totalTokens = emptyTokens();
  for (const it of view.iterations) {
    if (it.usage) totalTokens = addUsage(totalTokens, it.usage);
  }
  return {
    ...view,
    rollup: { ...view.rollup, totalTokens },
  };
};

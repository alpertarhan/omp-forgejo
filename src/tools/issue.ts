import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  batchGetIssues,
  batchPatchIssues,
  MAX_BATCH_REFS,
} from "./batch.js";
import { Type } from "typebox";
import { apiPath } from "../client.js";
import { formatResourceRef } from "../refs.js";
import type {
  ForgejoComment,
  ForgejoIssue,
  ForgejoTimelineEvent,
} from "../types.js";
import { incrementalConversationUpdates } from "./conversation.js";
import {
  boundModelText,
  createConversationComment,
  DEFAULT_MODEL_OUTPUT_BYTES,
  modelOutputBytes,
  confirmMutation,
  formatForgejoComment,
  handleConversationComment,
  handlePlanningMutation,
  handleSubscription,
  positiveLimit,
  resourceTargetProperties,
  timelineToolResult,
  toolResult,
  type RuntimeProvider,
} from "./common.js";
import { labelIds } from "./metadata.js";

function issueSummary(
  prefix: string,
  issue: ForgejoIssue,
  reference: string,
): string {
  return `${prefix} ${reference}: ${issue.title} [${issue.state}]`;
}

function userName(issue: ForgejoIssue): string {
  if (issue.user?.login) return `@${issue.user.login}`;
  if (issue.original_author) return issue.original_author;
  return "unknown";
}

function formatIssue(
  issue: ForgejoIssue,
  reference: string,
  comments: ForgejoComment[],
): string {
  const lines = [
    `Issue ${reference}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${userName(issue)}`,
    `Created: ${issue.created_at ?? "unknown"}`,
    `Updated: ${issue.updated_at}`,
    `Closed: ${issue.closed_at ?? "no"}`,
    `Assignees: ${issue.assignees?.map((user) => `@${user.login}`).join(", ") || "none"}`,
    `Labels: ${issue.labels?.map((label) => label.name).join(", ") || "none"}`,
    `Milestone: ${issue.milestone?.title ?? "none"}`,
    `Due: ${issue.due_date ?? "none"}`,
    `Locked: ${issue.is_locked ? "yes" : "no"}`,
    `Comments: ${issue.comments ?? comments.length}`,
    `URL: ${issue.html_url}`,
    "",
    "Body:",
    issue.body || "(empty)",
    "",
    `Discussion comments (${comments.length}):`,
    comments.length > 0
      ? comments.map(formatForgejoComment).join("\n\n")
      : "(none)",
  ];
  if (issue.assets?.length) {
    lines.splice(
      13,
      0,
      `Attachments: ${issue.assets.map((asset) => (asset.browser_download_url ? `${asset.name} (${asset.browser_download_url})` : asset.name)).join(", ")}`,
    );
  }
  return lines.join("\n");
}

export function registerIssueTool(
  pi: ExtensionAPI,
  runtimeProvider: RuntimeProvider,
): void {
  pi.registerTool({
    name: "forgejo_issue",
    label: "Forgejo Issue",
    description:
      "Read/manage qualified issues, discussion, metadata, subscriptions, and timelines. Close only when asked.",
    parameters: Type.Object({
      action: Type.Enum([
        "list",
        "get",
        "timeline",
        "updates",
        "create",
        "update",
        "comment",
        "get_comment",
        "edit_comment",
        "delete_comment",
        "subscription",
        "subscribe",
        "unsubscribe",
        "set_labels",
        "set_assignees",
        "set_milestone",
        "clear_milestone",
        "set_due_date",
        "clear_due_date",
        "close",
        "reopen",
      ] as const),
      ...resourceTargetProperties,
      refs: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: MAX_BATCH_REFS,
          description: "Batch get/update/close/reopen",
        }),
      ),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      comment_id: Type.Optional(Type.Integer({ minimum: 1 })),
      state: Type.Optional(Type.Enum(["open", "closed", "all"] as const)),
      query: Type.Optional(Type.String()),
      labels: Type.Optional(Type.Array(Type.String())),
      assignees: Type.Optional(Type.Array(Type.String())),
      milestone: Type.Optional(
        Type.String({
          minLength: 1,
        }),
      ),
      milestone_id: Type.Optional(
        Type.Integer({
          minimum: 1,
        }),
      ),
      due_date: Type.Optional(Type.String({ description: "RFC 3339" })),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      max_pages: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
        }),
      ),
      since: Type.Optional(Type.String({ description: "RFC 3339" })),
      before: Type.Optional(Type.String({ description: "RFC 3339" })),
      max_bytes: modelOutputBytes(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = runtimeProvider();
      if (params.refs !== undefined) {
        if (params.ref !== undefined)
          throw new Error("provide ref or refs, not both");
        if (params.action === "get")
          return batchGetIssues(
            runtime,
            params.refs,
            signal,
            params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
          );
        if (params.action === "update") {
          const patch: Record<string, unknown> = {};
          if (params.title !== undefined) patch.title = params.title;
          if (params.body !== undefined) patch.body = params.body;
          if (params.state !== undefined && params.state !== "all")
            patch.state = params.state;
          if (Object.keys(patch).length === 0)
            throw new Error("update requires title, body, or state");
          return batchPatchIssues(
            runtime,
            params.refs,
            patch,
            { verb: "Updated" },
            signal,
          );
        }
        if (params.action === "close") {
          await confirmMutation(runtime, ctx, {
            signal,
            approval: "issue.close",
            title: `Close ${params.refs.length} Forgejo issues`,
            message: params.refs
              .map((reference) => `- ${reference}`)
              .join("\n"),
          });
          return batchPatchIssues(
            runtime,
            params.refs,
            { state: "closed" },
            { verb: "Closed", requireState: "closed" },
            signal,
          );
        }
        if (params.action === "reopen")
          return batchPatchIssues(
            runtime,
            params.refs,
            { state: "open" },
            { verb: "Reopened", requireState: "open" },
            signal,
          );
        throw new Error("refs[] supports get, update, close, and reopen");
      }
      const repo = runtime.resolveRepo(params);
      const client = runtime.client(repo.server);
      const basePath = apiPath("repos", repo.owner, repo.repo, "issues");

      if (params.action === "list") {
        const response = await client.request<ForgejoIssue[]>(basePath, {
          query: {
            state: params.state ?? "open",
            type: "issues",
            q: params.query,
            page: params.page ?? 1,
            limit: positiveLimit(params.limit),
          },
          ...(signal === undefined ? {} : { signal }),
        });
        const lines = response.data.map(
          (issue) =>
            `- ${repo.server}:${repo.owner}/${repo.repo}#${issue.number} ${issue.title} [${issue.state}]`,
        );
        const total = response.totalCount ?? response.data.length;
        const bounded = boundModelText(
          [
            `Issues in ${repo.server}:${repo.owner}/${repo.repo}: ${total}`,
            ...lines,
          ].join("\n"),
          params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
        );
        return toolResult(bounded.text, {
          total,
          items: response.data,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }

      if (params.action === "create") {
        if (!params.title) throw new Error("title is required to create an issue");
        const body: Record<string, unknown> = { title: params.title };
        if (params.body !== undefined) body.body = params.body;
        if (params.assignees !== undefined) body.assignees = params.assignees;
        if (params.labels !== undefined)
          body.labels = await labelIds(
            client,
            repo.owner,
            repo.repo,
            params.labels,
            signal,
          );
        const response = await client.request<ForgejoIssue>(basePath, {
          method: "POST",
          body,
          ...(signal === undefined ? {} : { signal }),
        });
        const ref = `${repo.server}:${repo.owner}/${repo.repo}#${response.data.number}`;
        return toolResult(
          issueSummary("Created", response.data, ref),
          response.data,
        );
      }

      const ref = runtime.resolveResource(params, "issue");
      const reference = formatResourceRef(ref);
      const issuePath = apiPath("repos", ref.owner, ref.repo, "issues", ref.index);

      if (params.action === "get") {
        const requestOptions = signal === undefined ? {} : { signal };
        const [issue, comments] = await Promise.all([
          client.request<ForgejoIssue>(issuePath, requestOptions),
          client.request<ForgejoComment[]>(`${issuePath}/comments`, requestOptions),
        ]);
        const bounded = boundModelText(
          formatIssue(issue.data, reference, comments.data),
          params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
        );
        return toolResult(bounded.text, {
          issue: issue.data,
          comments: comments.data,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }
      if (params.action === "timeline") {
        const page = params.page ?? 1;
        const limit = positiveLimit(params.limit, 50);
        const response = await client.request<ForgejoTimelineEvent[]>(
          `${issuePath}/timeline`,
          {
            query: { page, limit, since: params.since, before: params.before },
            ...(signal === undefined ? {} : { signal }),
          },
        );
        return timelineToolResult(
          reference,
          response.data,
          page,
          limit,
          response.totalCount,
          params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
        );
      }
      if (params.action === "updates") {
        return incrementalConversationUpdates<ForgejoIssue>(runtime, ref, {
          currentPath: issuePath,
          timelinePath: `${issuePath}/timeline`,
          pageLimit: positiveLimit(params.limit, 50),
          maxPages: positiveLimit(params.max_pages, 20, 100),
          maximumBytes: params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
          ...(params.since === undefined ? {} : { since: params.since }),
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (params.action === "comment") {
        return createConversationComment(
          client,
          `${issuePath}/comments`,
          reference,
          params.body,
          "issue",
          signal,
        );
      }
      if (
        params.action === "get_comment" ||
        params.action === "edit_comment" ||
        params.action === "delete_comment"
      ) {
        return handleConversationComment(
          runtime,
          client,
          ref,
          reference,
          params.action,
          params.comment_id,
          params.body,
          ctx,
          signal,
        );
      }
      if (
        params.action === "subscription" ||
        params.action === "subscribe" ||
        params.action === "unsubscribe"
      ) {
        return handleSubscription(
          runtime,
          client,
          ref,
          reference,
          params.action,
          signal,
        );
      }
      if (
        params.action === "set_labels" ||
        params.action === "set_assignees" ||
        params.action === "set_milestone" ||
        params.action === "clear_milestone" ||
        params.action === "set_due_date" ||
        params.action === "clear_due_date"
      ) {
        return handlePlanningMutation<ForgejoIssue>({
          client,
          ref,
          reference,
          resourcePath: issuePath,
          action: params.action,
          params,
          summary: issueSummary,
          signal,
        });
      }
      if (params.action === "close") {
        await confirmMutation(runtime, ctx, {
          signal,
          approval: "issue.close",
          title: "Close Forgejo issue",
          message: `Server: ${ref.server}\nRepository: ${ref.owner}/${ref.repo}\nIssue: #${ref.index}`,
        });
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: { state: "closed" },
          ...(signal === undefined ? {} : { signal }),
        });
        if (response.data.state !== "closed")
          throw new Error(`Forgejo did not close ${reference}`);
        return toolResult(
          issueSummary("Closed", response.data, reference),
          response.data,
        );
      }
      if (params.action === "reopen") {
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: { state: "open" },
          ...(signal === undefined ? {} : { signal }),
        });
        if (response.data.state !== "open")
          throw new Error(`Forgejo did not reopen ${reference}`);
        return toolResult(
          issueSummary("Reopened", response.data, reference),
          response.data,
        );
      }

      const body: Record<string, unknown> = {};
      if (params.title !== undefined) body.title = params.title;
      if (params.body !== undefined) body.body = params.body;
      if (Object.keys(body).length === 0)
        throw new Error("update requires title or body");
      const response = await client.request<ForgejoIssue>(issuePath, {
        method: "PATCH",
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      return toolResult(
        issueSummary("Updated", response.data, reference),
        response.data,
      );
    },
  });
}

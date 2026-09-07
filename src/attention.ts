import type { ForgejoClient } from "./client.js";
import type {
  DashboardItem,
  ForgejoIssue,
  ForgejoNotification,
  ForgejoRepository,
} from "./types.js";

function repositoryParts(
  repository: ForgejoRepository | undefined,
  repositoryUrl: string | undefined,
): { owner: string; repo: string } | undefined {
  if (repository?.full_name) {
    const separator = repository.full_name.indexOf("/");
    if (separator > 0 && separator < repository.full_name.length - 1) {
      return {
        owner: repository.full_name.slice(0, separator),
        repo: repository.full_name.slice(separator + 1),
      };
    }
  }
  if (!repositoryUrl) return undefined;
  const match = /\/repos\/([^/]+)\/([^/?#]+)\/?$/.exec(repositoryUrl);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
  };
}

function reviewRequestItem(
  issue: ForgejoIssue,
  server: string,
): DashboardItem | undefined {
  const repository = repositoryParts(issue.repository, issue.repository_url);
  if (!repository) return undefined;
  return {
    key: `${server}:${repository.owner}/${repository.repo}:pull:${issue.number}:review`,
    server,
    owner: repository.owner,
    repo: repository.repo,
    kind: "review",
    resourceKind: "pull",
    index: issue.number,
    title: issue.title,
    updatedAt: issue.updated_at,
    webUrl: issue.html_url,
  };
}

function notificationIndex(
  notification: ForgejoNotification,
): number | undefined {
  const source =
    notification.subject.url ?? notification.subject.latest_comment_url;
  if (!source) return undefined;
  const matches = source.match(/\/(?:issues|pulls)\/(\d+)(?:\/|$)/);
  return matches?.[1] ? Number(matches[1]) : undefined;
}

function notificationItem(
  notification: ForgejoNotification,
  server: string,
  baseUrl: string,
): DashboardItem | undefined {
  const repository = repositoryParts(notification.repository, undefined);
  if (!repository) return undefined;
  const subjectType = notification.subject.type.toLowerCase();
  const resourceKind =
    subjectType === "pull"
      ? "pull"
      : subjectType === "issue"
        ? "issue"
        : "repository";
  const index = notificationIndex(notification);
  let webUrl =
    notification.subject.html_url ?? notification.repository.html_url;
  if (
    !notification.subject.html_url &&
    resourceKind !== "repository" &&
    index !== undefined
  ) {
    webUrl = `${baseUrl}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${resourceKind === "pull" ? "pulls" : "issues"}/${index}`;
  }
  const item: DashboardItem = {
    key: `${server}:notification:${notification.id}:${notification.updated_at}`,
    server,
    owner: repository.owner,
    repo: repository.repo,
    kind: "notification",
    resourceKind,
    title: notification.subject.title,
    updatedAt: notification.updated_at,
    webUrl,
    unread: notification.unread,
    sourceId: notification.id,
  };
  if (index !== undefined) item.index = index;
  return item;
}

export type AttentionTarget = "review_requests" | "notifications";

export async function queryAttentionItems(
  client: ForgejoClient,
  target: AttentionTarget,
  limit: number,
  signal?: AbortSignal,
): Promise<DashboardItem[]> {
  const requestOptions = signal === undefined ? {} : { signal };
  if (target === "review_requests") {
    const response = await client.request<ForgejoIssue[]>(
      "repos/issues/search",
      {
        ...requestOptions,
        query: {
          state: "open",
          type: "pulls",
          review_requested: true,
          limit,
          page: 1,
        },
      },
    );
    return response.data
      .map((issue) => reviewRequestItem(issue, client.alias))
      .filter((item): item is DashboardItem => item !== undefined);
  }
  const response = await client.request<ForgejoNotification[]>(
    "notifications",
    {
      ...requestOptions,
      query: { "status-types": ["unread"], limit, page: 1 },
    },
  );
  return response.data
    .map((notification) =>
      notificationItem(notification, client.alias, client.config.baseUrl),
    )
    .filter((item): item is DashboardItem => item !== undefined);
}

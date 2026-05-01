"""Pure logic for jira-pickup — the sprint-scoped, blocker-aware ticket picker.

Kept dependency-free so it can be unit-tested without atlassian-python-api or
the rest of the netresearch/jira-skill plugin's lib. The CLI wrapper
(`jira-pickup`) feeds it a real LazyJiraClient at runtime.
"""

from __future__ import annotations

from typing import Any, Iterable, Protocol


DEFAULT_FIELDS: tuple[str, ...] = (
    "summary",
    "status",
    "assignee",
    "priority",
    "issuelinks",
)


class _JqlClient(Protocol):
    def enhanced_jql(
        self, jql: str, *, limit: int, fields: list[str]
    ) -> dict[str, Any]: ...


def build_jql(
    *, sprint_id: int, project: str, status: str, label: str
) -> str:
    """Compose the canonical sprint-scoped JQL.

    Status is double-quoted because JIRA statuses contain spaces ("To Do",
    "In Progress"); project / label / sprint values are bare per JQL
    conventions in this project.
    """
    return (
        f"sprint = {sprint_id} AND project = {project} "
        f'AND status = "{status}" AND labels = {label} '
        "ORDER BY rank ASC"
    )


def _is_blocked(issue: dict[str, Any]) -> bool:
    """An issue is blocked if it has at least one `is blocked by` link
    pointing at an issue whose status is not "Done"."""
    links: Iterable[dict[str, Any]] = issue.get("fields", {}).get(
        "issuelinks", []
    ) or []
    for link in links:
        link_type = link.get("type", {}) or {}
        if link_type.get("inward") != "is blocked by":
            continue
        blocker = link.get("inwardIssue") or {}
        status_name = (
            (blocker.get("fields") or {}).get("status", {}) or {}
        ).get("name")
        if status_name != "Done":
            return True
    return False


def filter_blocked(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop issues that have any unresolved is-blocked-by link."""
    return [issue for issue in issues if not _is_blocked(issue)]


def pickup(
    client: _JqlClient,
    *,
    sprint_id: int,
    project: str,
    status: str,
    label: str,
    max_results: int = 50,
) -> list[dict[str, Any]]:
    """Run the sprint-scoped JQL, then post-filter blocked tickets."""
    jql = build_jql(
        sprint_id=sprint_id, project=project, status=status, label=label
    )
    response = client.enhanced_jql(
        jql, limit=max_results, fields=list(DEFAULT_FIELDS)
    )
    issues = response.get("issues", []) or []
    return filter_blocked(issues)

"""Tests for jira-pickup — sprint-scoped JIRA pickup with blocked-by post-filter."""

from unittest.mock import MagicMock

import pytest

from jira_pickup_lib import (
    DEFAULT_FIELDS,
    build_jql,
    filter_blocked,
    pickup,
)


# ---------------------------------------------------------------------------
# Slice 2 — empty result + JQL composition
# ---------------------------------------------------------------------------


def test_pickup_with_empty_jql_response_returns_empty_list():
    client = MagicMock()
    client.enhanced_jql.return_value = {"issues": []}

    result = pickup(
        client,
        sprint_id=37,
        project="VGD",
        status="To Do",
        label="autonomous",
    )

    assert result == []


def test_pickup_calls_client_with_canonical_vgd_jql():
    client = MagicMock()
    client.enhanced_jql.return_value = {"issues": []}

    pickup(
        client,
        sprint_id=37,
        project="VGD",
        status="To Do",
        label="autonomous",
    )

    args, kwargs = client.enhanced_jql.call_args
    jql = args[0] if args else kwargs["jql"]
    assert jql == (
        'sprint = 37 AND project = VGD AND status = "To Do" '
        "AND labels = autonomous ORDER BY rank ASC"
    )


def test_build_jql_emits_the_canonical_string():
    assert build_jql(
        sprint_id=37,
        project="VGD",
        status="To Do",
        label="autonomous",
    ) == (
        'sprint = 37 AND project = VGD AND status = "To Do" '
        "AND labels = autonomous ORDER BY rank ASC"
    )


def test_pickup_requests_issuelinks_in_fields():
    """Without `issuelinks` in the requested fields, the blocked-by post-filter
    can't see the link data and we'd silently let blocked tickets through."""
    client = MagicMock()
    client.enhanced_jql.return_value = {"issues": []}

    pickup(
        client,
        sprint_id=37,
        project="VGD",
        status="To Do",
        label="autonomous",
    )

    _, kwargs = client.enhanced_jql.call_args
    fields = kwargs.get("fields") or []
    assert "issuelinks" in fields


# ---------------------------------------------------------------------------
# Slice 3 — pass-through for tickets with no issuelinks
# ---------------------------------------------------------------------------


def _issue(key: str, links: list[dict] | None = None) -> dict:
    return {
        "key": key,
        "fields": {
            "summary": f"Summary for {key}",
            "issuelinks": links if links is not None else [],
        },
    }


def test_filter_blocked_keeps_issue_with_no_issuelinks():
    issue = _issue("VGD-200", links=[])
    assert filter_blocked([issue]) == [issue]


def test_filter_blocked_keeps_issue_with_links_but_no_blocked_by():
    issue = _issue(
        "VGD-201",
        links=[
            {
                "type": {"inward": "relates to", "outward": "relates to"},
                "outwardIssue": {
                    "key": "VGD-99",
                    "fields": {"status": {"name": "To Do"}},
                },
            }
        ],
    )
    assert filter_blocked([issue]) == [issue]


# ---------------------------------------------------------------------------
# Slice 4 — drop tickets with any unresolved is-blocked-by link
# ---------------------------------------------------------------------------


def test_filter_blocked_drops_issue_with_unresolved_blocker():
    issue = _issue(
        "VGD-202",
        links=[
            {
                "type": {"inward": "is blocked by", "outward": "blocks"},
                "inwardIssue": {
                    "key": "VGD-99",
                    "fields": {"status": {"name": "To Do"}},
                },
            }
        ],
    )
    assert filter_blocked([issue]) == []


def test_filter_blocked_drops_when_any_blocker_unresolved_even_if_others_done():
    issue = _issue(
        "VGD-203",
        links=[
            {
                "type": {"inward": "is blocked by", "outward": "blocks"},
                "inwardIssue": {
                    "key": "VGD-90",
                    "fields": {"status": {"name": "Done"}},
                },
            },
            {
                "type": {"inward": "is blocked by", "outward": "blocks"},
                "inwardIssue": {
                    "key": "VGD-91",
                    "fields": {"status": {"name": "In Progress"}},
                },
            },
        ],
    )
    assert filter_blocked([issue]) == []


# ---------------------------------------------------------------------------
# Slice 5 — all blockers Done → keep
# ---------------------------------------------------------------------------


def test_filter_blocked_keeps_issue_when_all_blockers_done():
    issue = _issue(
        "VGD-204",
        links=[
            {
                "type": {"inward": "is blocked by", "outward": "blocks"},
                "inwardIssue": {
                    "key": "VGD-92",
                    "fields": {"status": {"name": "Done"}},
                },
            },
            {
                "type": {"inward": "is blocked by", "outward": "blocks"},
                "inwardIssue": {
                    "key": "VGD-93",
                    "fields": {"status": {"name": "Done"}},
                },
            },
        ],
    )
    assert filter_blocked([issue]) == [issue]


# ---------------------------------------------------------------------------
# Slice 6 — output shape parity with jira-search.py --json
# ---------------------------------------------------------------------------


def test_pickup_returns_issues_in_jira_search_shape():
    """jira-search.py with --json prints the `issues` array (each item has
    `key` and `fields`). pickup() returns the same array shape so callers can
    treat the two interchangeably."""
    raw_issue = {
        "key": "VGD-300",
        "fields": {
            "summary": "Add JWKS endpoint",
            "status": {"name": "To Do"},
            "issuelinks": [],
        },
    }
    client = MagicMock()
    client.enhanced_jql.return_value = {"issues": [raw_issue]}

    result = pickup(
        client,
        sprint_id=37,
        project="VGD",
        status="To Do",
        label="autonomous",
    )

    assert result == [raw_issue]


def test_default_fields_includes_summary_status_assignee_priority_issuelinks():
    """Caller convenience — match jira-search.py defaults plus issuelinks."""
    for required in ("summary", "status", "issuelinks"):
        assert required in DEFAULT_FIELDS


# ---------------------------------------------------------------------------
# Slice 6b — CLI emits the filtered issue list as JSON on stdout
# ---------------------------------------------------------------------------


def test_cli_emits_filtered_issues_as_json(monkeypatch):
    import importlib.util
    import json
    from pathlib import Path

    from click.testing import CliRunner

    raw_issues = [
        # Kept: no blockers
        {
            "key": "VGD-300",
            "fields": {
                "summary": "Add JWKS endpoint",
                "status": {"name": "To Do"},
                "issuelinks": [],
            },
        },
        # Dropped: unresolved blocker
        {
            "key": "VGD-301",
            "fields": {
                "summary": "Wire OIDC discovery",
                "status": {"name": "To Do"},
                "issuelinks": [
                    {
                        "type": {"inward": "is blocked by"},
                        "inwardIssue": {
                            "key": "VGD-99",
                            "fields": {"status": {"name": "To Do"}},
                        },
                    }
                ],
            },
        },
    ]

    fake_client = MagicMock()
    fake_client.enhanced_jql.return_value = {"issues": raw_issues}

    # The CLI builds a LazyJiraClient internally; replace the constructor.
    script_dir = (
        Path(__file__).parent.parent
        / "skills"
        / "jira-communication"
        / "scripts"
        / "core"
    )
    script_path = script_dir / "jira-pickup"
    spec = importlib.util.spec_from_loader(
        "jira_pickup_cli",
        importlib.machinery.SourceFileLoader("jira_pickup_cli", str(script_path)),
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    monkeypatch.setattr(module, "LazyJiraClient", lambda **_kwargs: fake_client)

    runner = CliRunner()
    result = runner.invoke(module.cli, [])
    assert result.exit_code == 0, result.output
    parsed = json.loads(result.output)
    # Only the unblocked issue survives.
    assert [i["key"] for i in parsed] == ["VGD-300"]
    # Each emitted issue keeps the jira-search.py shape (key + fields dict).
    assert "fields" in parsed[0]

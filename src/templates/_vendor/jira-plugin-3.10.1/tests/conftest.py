"""Test scaffolding.

`jira-pickup` (and the rest of the netresearch/jira-skill plugin) imports from
`lib.client` and `lib.output`, which live in the cloned plugin tree at runtime.
For unit tests we only need those names to be importable; tests then
`monkeypatch.setattr(...)` the symbols they actually exercise. Stubbing them
in `sys.modules` lets the CLI script load without the full plugin checkout.
"""

import sys
import types


def _install_lib_stubs() -> None:
    if "lib" in sys.modules:
        return
    lib = types.ModuleType("lib")
    client = types.ModuleType("lib.client")

    class _StubLazyJiraClient:  # noqa: D401 — placeholder
        """Replaced by monkeypatch in tests that exercise the CLI."""

        def __init__(self, *_args, **_kwargs) -> None:
            raise RuntimeError(
                "Real LazyJiraClient called from a unit test — "
                "monkeypatch.setattr the script's binding before invoking it."
            )

    client.LazyJiraClient = _StubLazyJiraClient
    lib.client = client
    sys.modules["lib"] = lib
    sys.modules["lib.client"] = client


_install_lib_stubs()

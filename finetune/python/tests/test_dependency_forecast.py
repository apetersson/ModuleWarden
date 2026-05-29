"""Tests for finetune.python.serving.dependency_forecast.

All tests run with no model and no network. The per-dependency scorer is a
stub callable so the rollup math is the only thing under test.
"""

from __future__ import annotations

import math

import pytest

from finetune.python.serving.dependency_forecast import (
    forecast_dependency_tree,
    parse_dependencies,
    summarize,
)


def _const_score(p):
    """Build a stub scorer that returns a fixed probability for every dep."""

    def _scorer(dep):
        return p

    return _scorer


def _by_name_score(table, default=0.0):
    """Build a stub scorer that looks the probability up by dependency name."""

    def _scorer(dep):
        return table.get(dep["name"], default)

    return _scorer


# --- parse_dependencies, all three input shapes ---------------------------


def test_parse_string_list_name_at_version():
    parsed = parse_dependencies(["left-pad@1.3.0", "requests@2.31.0"])
    assert parsed == [
        {"name": "left-pad", "version": "1.3.0"},
        {"name": "requests", "version": "2.31.0"},
    ]


def test_parse_string_bare_name_gets_unknown_version():
    parsed = parse_dependencies(["mystery-pkg"])
    assert parsed == [{"name": "mystery-pkg", "version": "unknown"}]


def test_parse_string_scoped_npm_name_keeps_scope():
    parsed = parse_dependencies(["@scope/pkg@1.2.3"])
    assert parsed == [{"name": "@scope/pkg", "version": "1.2.3"}]


def test_parse_dict_list():
    parsed = parse_dependencies(
        [
            {"name": "flask", "version": "3.0.0"},
            {"name": "numpy", "version": "1.26.0"},
        ]
    )
    assert parsed == [
        {"name": "flask", "version": "3.0.0"},
        {"name": "numpy", "version": "1.26.0"},
    ]


def test_parse_package_json_style_mapping():
    pkg = {
        "dependencies": {
            "express": "^4.18.2",
            "lodash": "4.17.21",
        }
    }
    parsed = parse_dependencies(pkg)
    assert parsed == [
        {"name": "express", "version": "^4.18.2"},
        {"name": "lodash", "version": "4.17.21"},
    ]


def test_parse_bare_mapping_without_dependencies_key():
    parsed = parse_dependencies({"axios": "1.6.0"})
    assert parsed == [{"name": "axios", "version": "1.6.0"}]


def test_parse_drops_empty_names_and_skips_unknown_items():
    parsed = parse_dependencies(["", "good@1.0.0", 42, None])
    assert parsed == [{"name": "good", "version": "1.0.0"}]


def test_parse_none_and_empty():
    assert parse_dependencies(None) == []
    assert parse_dependencies([]) == []
    assert parse_dependencies({}) == []


def test_parse_rejects_unsupported_type():
    with pytest.raises(TypeError):
        parse_dependencies(12345)


# --- forecast_dependency_tree --------------------------------------------


def test_clean_tree_low_submission_risk():
    deps = ["a@1", "b@1", "c@1", "d@1", "e@1"]
    result = forecast_dependency_tree(deps, _const_score(0.01))
    # 1 - 0.99**5 is about 0.049, comfortably low.
    assert result["submission_risk"] < 0.10
    assert result["n_deps"] == 5
    assert result["mean_probability"] == pytest.approx(0.01)


def test_one_bad_dep_dominates_submission_risk():
    deps = ["clean-1@1", "clean-2@1", "evil@6.6.6", "clean-3@1"]
    table = {"evil": 0.9}
    result = forecast_dependency_tree(deps, _by_name_score(table, default=0.01))
    # The 0.9 dep alone forces submission_risk above 0.9.
    assert result["submission_risk"] > 0.9
    assert result["riskiest"][0]["name"] == "evil"


def test_expected_compromised_equals_sum_of_probs():
    deps = ["a@1", "b@1", "c@1"]
    table = {"a": 0.1, "b": 0.2, "c": 0.3}
    result = forecast_dependency_tree(deps, _by_name_score(table))
    assert result["expected_compromised"] == pytest.approx(0.6)


def test_submission_risk_formula():
    deps = ["a@1", "b@1"]
    table = {"a": 0.5, "b": 0.5}
    result = forecast_dependency_tree(deps, _by_name_score(table))
    # 1 - (0.5 * 0.5) = 0.75
    assert result["submission_risk"] == pytest.approx(0.75)


def test_riskiest_sorted_descending():
    deps = ["a@1", "b@1", "c@1", "d@1"]
    table = {"a": 0.1, "b": 0.9, "c": 0.4, "d": 0.6}
    result = forecast_dependency_tree(deps, _by_name_score(table))
    probs = [entry["probability"] for entry in result["riskiest"]]
    assert probs == sorted(probs, reverse=True)
    assert result["riskiest"][0]["name"] == "b"


def test_riskiest_stable_on_ties():
    deps = ["first@1", "second@1", "third@1"]
    result = forecast_dependency_tree(deps, _const_score(0.2))
    # Equal probabilities preserve input order.
    assert [entry["name"] for entry in result["riskiest"]] == [
        "first",
        "second",
        "third",
    ]


def test_probabilities_clamped():
    deps = ["over@1", "under@1", "junk@1"]
    table = {"over": 5.0, "under": -3.0, "junk": float("nan")}
    result = forecast_dependency_tree(deps, _by_name_score(table))
    by_name = {entry["name"]: entry["probability"] for entry in result["per_dep"]}
    assert by_name["over"] == 1.0
    assert by_name["under"] == 0.0
    assert by_name["junk"] == 0.0


def test_non_numeric_score_collapses_to_zero():
    deps = ["weird@1"]
    result = forecast_dependency_tree(deps, lambda dep: "not-a-number")
    assert result["per_dep"][0]["probability"] == 0.0
    assert result["submission_risk"] == 0.0


def test_empty_input_zeroes():
    result = forecast_dependency_tree([], _const_score(0.5))
    assert result["submission_risk"] == 0.0
    assert result["expected_compromised"] == 0.0
    assert result["mean_probability"] == 0.0
    assert result["n_deps"] == 0
    assert result["per_dep"] == []
    assert result["riskiest"] == []


def test_per_dep_preserves_input_order():
    deps = ["z@1", "y@1", "x@1"]
    result = forecast_dependency_tree(deps, _const_score(0.3))
    assert [entry["name"] for entry in result["per_dep"]] == ["z", "y", "x"]


def test_score_fn_receives_normalized_dict():
    seen = []

    def _recorder(dep):
        seen.append(dep)
        return 0.0

    forecast_dependency_tree(["pkg@2.0.0"], _recorder)
    assert seen == [{"name": "pkg", "version": "2.0.0"}]


# --- summarize ------------------------------------------------------------


def test_summarize_empty():
    result = forecast_dependency_tree([], _const_score(0.5))
    text = summarize(result)
    assert "0.0 percent" in text
    assert "No dependencies" in text


def test_summarize_names_top_k_and_percentage():
    deps = ["a@1", "b@2", "c@3"]
    table = {"a": 0.1, "b": 0.9, "c": 0.4}
    result = forecast_dependency_tree(deps, _by_name_score(table))
    text = summarize(result, top_k=2)
    # Top two riskiest are b then c, named with versions.
    assert "b@2" in text
    assert "c@3" in text
    assert "a@1" not in text
    assert "percent" in text


def test_summarize_top_k_zero_omits_names():
    deps = ["a@1", "b@1"]
    result = forecast_dependency_tree(deps, _const_score(0.5))
    text = summarize(result, top_k=0)
    assert "riskiest dependencies are" not in text
    assert "percent" in text


def test_summarize_singular_dependency_wording():
    result = forecast_dependency_tree(["solo@1"], _const_score(0.2))
    text = summarize(result)
    assert "1 dependency" in text


def test_summarize_risk_percentage_matches_result():
    deps = ["a@1", "b@1"]
    table = {"a": 0.5, "b": 0.5}
    result = forecast_dependency_tree(deps, _by_name_score(table))
    text = summarize(result)
    # submission_risk 0.75 renders as 75.0 percent.
    assert "75.0 percent" in text
    assert math.isclose(result["submission_risk"], 0.75)

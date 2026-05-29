"""Tests for B4 spiral brake (ToolCallBudget).

Verifies the soft stop signal, strict raise, counting accuracy, boundary
idempotence, reset, and constructor validation.
"""

from __future__ import annotations

import pytest

from finetune.python.serving.spiral_brake import ToolBudgetExceeded, ToolCallBudget


def test_consume_within_budget_returns_true_and_counts():
    b = ToolCallBudget(max_calls=3)
    assert b.consume() is True
    assert b.consume() is True
    assert b.used == 2
    assert b.remaining == 1


def test_soft_mode_returns_false_at_cap_without_raising():
    b = ToolCallBudget(max_calls=2)  # soft is default
    assert b.consume() is True
    assert b.consume() is True
    # Third call trips the brake: stop signal, no exception.
    assert b.consume() is False
    assert b.exhausted() is True
    assert b.remaining == 0


def test_soft_mode_does_not_inflate_used_past_cap():
    b = ToolCallBudget(max_calls=1)
    assert b.consume() is True
    assert b.consume() is False
    assert b.consume() is False
    assert b.used == 1  # boundary idempotent


def test_strict_mode_raises_at_cap():
    b = ToolCallBudget(max_calls=2, strict=True)
    b.consume()
    b.consume()
    with pytest.raises(ToolBudgetExceeded) as exc:
        b.consume()
    assert exc.value.max_calls == 2
    # Used was not inflated by the failed attempt.
    assert b.used == 2


def test_check_is_non_consuming():
    b = ToolCallBudget(max_calls=1)
    assert b.check() is True
    assert b.used == 0  # check did not consume
    b.consume()
    assert b.check() is False


def test_consume_n_at_once():
    b = ToolCallBudget(max_calls=5)
    assert b.consume(3) is True
    assert b.used == 3
    # 3 + 3 would exceed 5: rejected, count unchanged.
    assert b.consume(3) is False
    assert b.used == 3
    assert b.consume(2) is True
    assert b.used == 5


def test_reset_restores_full_budget():
    b = ToolCallBudget(max_calls=2)
    b.consume()
    b.consume()
    assert b.exhausted() is True
    b.reset()
    assert b.used == 0
    assert b.exhausted() is False
    assert b.consume() is True


def test_typical_loop_breaks_before_spiral():
    # Simulate a crafted-README spiral: agent keeps wanting tools forever.
    b = ToolCallBudget(max_calls=35)
    dispatched = 0
    while True:
        if not b.consume():
            break
        dispatched += 1
    assert dispatched == 35  # brake held at the cap


def test_constructor_rejects_bad_max_calls():
    with pytest.raises(ValueError):
        ToolCallBudget(max_calls=0)
    with pytest.raises(ValueError):
        ToolCallBudget(max_calls=-1)
    with pytest.raises(TypeError):
        ToolCallBudget(max_calls=True)  # bool is not a valid int cap
    with pytest.raises(TypeError):
        ToolCallBudget(max_calls=2.5)


def test_consume_rejects_non_positive_n():
    b = ToolCallBudget(max_calls=3)
    with pytest.raises(ValueError):
        b.consume(0)

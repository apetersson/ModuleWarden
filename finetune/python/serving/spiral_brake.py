"""B4 spiral brake (BitGN-PAC reference, MIT; fit note 07 sec 2.2).

The agentic audit runner (PI harness, matrix arms 3/4) has a per-case wall-clock
timeout but no cap on how many tool calls a single audit may make. A crafted
README can push the agent into a tool-call spiral, requesting tool after tool
until the timeout fires, burning the whole budget on one malicious package.

`ToolCallBudget` is a small reusable counter for the harness loop. Call
`check()` (or `consume()`) before each tool dispatch. Once the cap is reached it
either raises `ToolBudgetExceeded` (strict mode) or returns a stop signal
(soft mode), so the harness can break the loop and emit a partial report instead
of spiraling.

Pure in-process state. No I/O. Thread-unsafe by design (one budget per audit).
"""

from __future__ import annotations


class ToolBudgetExceeded(RuntimeError):
    """Raised by ToolCallBudget.consume() in strict mode when the cap is hit."""

    def __init__(self, used: int, max_calls: int) -> None:
        self.used = used
        self.max_calls = max_calls
        super().__init__(
            f"tool-call budget exhausted: {used} call(s) attempted, cap is {max_calls}"
        )


class ToolCallBudget:
    """Caps the number of tool calls in a single agentic audit.

    Args:
        max_calls: the hard cap on tool calls. Must be a positive integer.
        strict: if True, `consume()` raises ToolBudgetExceeded once the cap is
            reached. If False (default), `consume()` returns False at the cap so
            the caller can break the loop without exception handling.

    Usage in a harness loop:

        budget = ToolCallBudget(max_calls=35)
        while need_more_work:
            if not budget.consume():      # soft mode: stop signal
                break                     # emit partial report, do not spiral
            result = dispatch_tool(...)

    Or strict:

        budget = ToolCallBudget(max_calls=35, strict=True)
        budget.consume()                  # raises once the 36th call is tried
    """

    def __init__(self, max_calls: int, strict: bool = False) -> None:
        if not isinstance(max_calls, int) or isinstance(max_calls, bool):
            raise TypeError("max_calls must be an int")
        if max_calls < 1:
            raise ValueError("max_calls must be a positive integer")
        self.max_calls = max_calls
        self.strict = strict
        self._used = 0

    @property
    def used(self) -> int:
        """Number of tool calls consumed so far."""
        return self._used

    @property
    def remaining(self) -> int:
        """Tool calls still available before the cap. Never negative."""
        return max(0, self.max_calls - self._used)

    def exhausted(self) -> bool:
        """True if the budget has no remaining capacity. Read-only, no mutation."""
        return self._used >= self.max_calls

    def consume(self, n: int = 1) -> bool:
        """Account for `n` tool call(s) about to be made.

        Returns True if the call(s) are within budget (the count is recorded).
        At or beyond the cap it does NOT increment, and either raises
        ToolBudgetExceeded (strict) or returns False (soft) so the harness can
        break the loop. Idempotent at the boundary: repeated calls past the cap
        keep returning False / raising without inflating `used`.
        """
        if n < 1:
            raise ValueError("n must be a positive integer")
        if self._used + n > self.max_calls:
            if self.strict:
                raise ToolBudgetExceeded(self._used + n, self.max_calls)
            return False
        self._used += n
        return True

    def check(self) -> bool:
        """Non-consuming peek: True if at least one more call fits in budget."""
        return not self.exhausted()

    def reset(self) -> None:
        """Reset the consumed count to zero (reuse the budget for a new audit)."""
        self._used = 0


__all__ = [
    "ToolCallBudget",
    "ToolBudgetExceeded",
]

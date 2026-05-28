"""Attack-pattern catalog and the PatternInjector that applies it.

The YAML catalog at ``finetune/python/data/patterns/attack-catalog.yaml``
encodes 26 npm-supply-chain attack patterns drawn from real CISA, Snyk,
Socket, and JFrog incident writeups. ``PatternInjector`` loads the
catalog and applies templated payloads to benign package directories to
produce labeled synthetic examples for the corpus.
"""

from .injector import PatternInjector

__all__ = ["PatternInjector"]

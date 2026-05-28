"""Dossier and SFT-record construction from scraped GHSA cases.

Modules:

- ``version_pair_extractor``: pull unpatched + patched npm tarballs and diff them
- ``dossier_builder``: emit ``audit_dossier.v1`` from a VersionPair + scraped case
- ``report_template``: emit ground-truth ``audit_report.v1`` from a dossier + label hint
- ``sft_pair_builder``: pair (Dossier, Report) into ``sft_record.v1`` messages
- ``corpus_walker``: walk scraped-cases.jsonl into sft-records.jsonl
"""

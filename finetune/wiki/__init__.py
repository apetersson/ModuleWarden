"""ModuleWarden LLM-wiki package.

Two living knowledge graphs grounded in the repo's demo data:

- ``auditor/``     defensive nodes the auditor model reads via BM25 RAG.
- ``decepticon/``  offensive technique + chain nodes Decepticon owns.

Design: docs/winning-research/06-llm-wiki-for-models.md. Nodes are
markdown files with a YAML front-matter block plus a prose body. No
graph database, no vector store. The indexer reads raw markdown.
"""

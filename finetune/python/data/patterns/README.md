# Attack-pattern catalog

`attack-catalog.yaml` is a YAML-encoded catalog of 26 npm supply-chain attack
patterns drawn from real CISA, Snyk, Socket, JFrog, and Bleeping Computer
incident writeups since 2018. Each entry includes:

- `id` - stable identifier (e.g. `install-exfil-01`)
- `severity` - integer 1 to 10, used as a sampling weight
- `description` - short human-readable summary
- `inject.files` - new files to add to the benign package
- `inject.modify` - existing files to mutate (typically `package.json` `merge_json`)
- `template_variables` - randomization slots (e.g. `{{C2_HOST}}`, `{{EXFIL_URL}}`)
- `diversity_strategies` - mutation techniques applied per variant
- `variants_to_generate` - how many distinct realizations to produce
- `citations` - source incident writeups for the pattern

The catalog is the data foundation for the synthetic-malicious training
corpus. `PatternInjector` (in `injector.py`) loads the YAML and stamps a
pattern onto a benign-package directory in place. The driver script
`finetune/python/scripts/synthesize_data.py` walks a benign-package
corpus, samples patterns weighted by severity, and emits synthetic
variants plus a `manifest.jsonl` that downstream pipeline code consumes
to build SFT records.

## Pattern families covered

Counts and ids read directly from `attack-catalog.yaml`. 26 patterns total across 10 families.

| Family | Count | Sample ids |
|---|---|---|
| code_execution | 3 | `eval_base64_payload`, `function_constructor_abuse`, `dynamic_require_abuse` |
| composer_lifecycle | 2 | `composer_post_install_cmd`, `composer_typosquat` |
| filesystem | 4 | `ssh_key_theft`, `shell_rc_backdoor`, `npmrc_credential_theft` |
| lifecycle_hijack | 3 | `postinstall_env_exfil`, `preinstall_shell_payload`, `prepare_script_hijack` |
| mcp_specific | 2 | `mcp_hidden_tool_exfil`, `mcp_config_injection` |
| network | 4 | `dns_exfil`, `discord_webhook_exfil`, `telegram_bot_exfil` |
| obfuscation | 2 | `identifier_mangling`, `string_concat_url_hiding` |
| persistence | 2 | `cryptominer_dropper`, `reverse_shell` |
| pypi_lifecycle | 2 | `pypi_setup_py_exfil`, `pypi_dependency_confusion` |
| supply_chain_manipulation | 2 | `dependency_confusion`, `subdep_injection` |

## Citations are real

Every pattern in the catalog ships with `citations:` pointing to a real
incident writeup. Examples:

- `event-stream / flatmap-stream` (2018) - underpins lifecycle_hijack patterns
- `ua-parser-js` compromise (2021) - underpins postinstall family
- `node-ipc protestware` (2022) - underpins persistence + destructive family
- `Shai-Hulud worm` (Nov 2025) - underpins self-replication patterns
- `postmark-mcp` (Sep 2025) - underpins data_exfil family

The model trained on these patterns sees the structural shape of every
mainstream npm supply-chain attack class published since 2018.

## How to extend

Each new pattern needs only an `id`, `severity`, `description`, and an
`inject` block. The catalog loader tolerates missing optional fields and
falls back to sensible defaults. New patterns should include a `citations`
entry so the provenance survives.

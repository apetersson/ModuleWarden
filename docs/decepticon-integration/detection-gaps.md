# Decepticon detection gaps: where the static delta-gate is blind

Offense feeds defense. The Decepticon brain (a local uncensored heretic-v2, run
red-team side) was pointed at the deterministic capability-to-ATT&CK mapper in
`finetune/python/decepticon/mapper.py` and asked, per capability key, what
version-delta attacks a purely static delta-gate using that table would miss.
The list below is the offense-side input to the `_CAPABILITY_TO_ATTACK`
extension work. The mapper stays deterministic; this records what to add, not a
model deciding anything.

| capability_key | technique_id | what the lookup catches | detection_gap a delta-gate misses | proposed new signal/key |
|---|---|---|---|---|
| `lifecycle_script` | T1195.002 | Explicit `install`/`postinstall` scripts added to `package.json` | Hooks injected via `.npmrc` `scripts-prepend` or global config overrides rather than the package manifest | `npmrc_scripts_prepend` |
| `dynamic_code_execution` | T1059.007 | Direct `eval()`, `new Function()`, or `Array.map` usage in diffed source | Payloads assembled via `import.meta.resolve` or chained dynamic `import()` calls | `dynamic_import_chain` |
| `credential_or_env_access` | T1552.001 | Direct `process.env` reads or hardcoded path globs (e.g. `~/.npmrc`) | Reads from mounted secret volumes (`/run/secrets/*`) or CI-variable-gated conditional reads | `env_conditional_read` |
| `process_execution` | T1059 | `spawn`, `exec`, `execSync` calls in diffed JS/TS | Shell commands built via template literals or backtick concatenation before execution | `shell_construct_delta` |
| `native_or_wasm` | T1106 | New `.node` or `.wasm` binaries added to the tarball | Native modules compiled for multiple architectures with identical hashes, or lazy-loaded via `require` | `native_binary_diff` |
| `obfuscation` | T1027 | Variable renaming, string arrays, or minification in the source diff | Self-modifying code that decodes payloads at runtime via bitwise ops or char codes | `runtime_decode_pattern` |
| `network_access` | T1041 | New `fetch`, `http.get`, or `net` module imports | Implicit network hops via DNS-over-HTTPS or proxy env injection | `proxy_env_injection` |
| `filesystem_sensitive_access` | T1005 | `fs.readFile`/`fs.readdir` on known paths (`/etc`, `~/.ssh`) | Recursive traversal with hidden-file filtering or symlink-follow logic | `symlink_traversal_delta` |
| `behavioral_change_runtime` | T1059 | Exported function signature changes or default value shifts | Silent polyfill injection or prototype-chain mutation (`Object.prototype`) | `prototype_mutation` |

## New capability keys to add (absent from the table today)

- `env_regex_gate`: payloads that only execute when `process.env` or CI variables match a regex (e.g. `if (/^(development|ci)$/.test(process.env.NODE_ENV))`), bypassing static env-read scans.
- `npmrc_scripts_prepend`: lifecycle hooks injected via `.npmrc` `scripts-prepend` fields instead of `package.json`, invisible to manifest-only differs.
- `transitive_dep_swap`: silent version bumps or peer-dependency overrides in `package.json` that force a different transitive tree, altering runtime behavior with no direct code change.
- `maintainer_token_reuse`: publish-metadata deltas indicating registry token rotation or maintainer account takeover (e.g. a new `publishConfig` or `registry` field), a supply-chain origin-compromise signal.
- `fetch_exec_pipeline`: postinstall hooks that chain a synchronous `fetch` plus `eval`/`exec` without declaring network capability in the initial diff scan, merging exfiltration and execution into one step.

These are narrate-only at hackathon scale: the gaps are the offense-side input
to future deterministic-gate rules, not a claim that the gate already covers
them.

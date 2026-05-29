# ModuleWarden classifier floor - measured metrics

Backend: `sklearn.GradientBoostingClassifier`  |  features: 16  |  benign=400 malicious=400  |  train/calib/test = 480/160/160

## Ranking + calibration (held-out test)

- AUROC: **0.5387**
- PR-AUC (avg precision): **0.6053**  (honest under imbalance)
- Brier score: **0.3059**  (lower is better)
- ECE (10-bin): **0.2310**

- High-precision op point thr=0.98: precision=1.000 recall=0.037 FPR=0.000
- Default thr=0.50: precision=0.506 recall=0.512 FPR=0.500

## Split-conformal (marginal, alpha=0.10)

- target coverage 0.90, **measured coverage 0.856**, avg set size 1.69 (n_cal=160)

## Reliability bins (mean predicted vs observed)

| bin | n | mean P | obs frac |
|----|---|--------|----------|
| 0.0-0.1 | 10 | 0.071 | 0.600 |
| 0.1-0.2 | 14 | 0.162 | 0.429 |
| 0.2-0.3 | 13 | 0.255 | 0.462 |
| 0.3-0.4 | 25 | 0.345 | 0.480 |
| 0.4-0.5 | 17 | 0.454 | 0.529 |
| 0.5-0.6 | 16 | 0.558 | 0.375 |
| 0.6-0.7 | 18 | 0.657 | 0.333 |
| 0.7-0.8 | 14 | 0.762 | 0.571 |
| 0.8-0.9 | 13 | 0.846 | 0.462 |
| 0.9-1.0 | 20 | 0.959 | 0.750 |

## Top static features by importance

- `entropy`: 0.4355
- `file_count`: 0.2078
- `pj_dev_dep_count`: 0.1365
- `pj_dep_count`: 0.1043
- `capability_delta_count`: 0.0471
- `cap_dynamic_code_execution`: 0.0146
- `cap_credential_or_env_access`: 0.0103
- `cap_process_execution`: 0.0095
- `cap_native_or_wasm`: 0.0093
- `cap_filesystem_sensitive_access`: 0.0056
- `pj_has_install_script`: 0.0047
- `cap_lifecycle_script`: 0.0043

_reliability-diagram.png written (C:\Projects\_Jobs\Collaborations\Andrew\_mw-clone\finetune\python\eval\reliability-diagram.png)_

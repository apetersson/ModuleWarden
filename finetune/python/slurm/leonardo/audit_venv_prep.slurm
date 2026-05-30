#!/bin/bash
# Build a dedicated, stable transformers venv for the auditor timing path, independent
# of the fine-tune env (mwenv57b) that gets rebuilt by other jobs. Runs as a serial
# job (login arbiter only applies to login nodes; serial nodes are safe for pip).
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=lrd_all_serial
#SBATCH --time=00:25:00
#SBATCH --mem=24G
#SBATCH --cpus-per-task=4
#SBATCH --job-name=mw-audit-venv
#SBATCH --output=%x-%j.out

set -x
SCRATCH="${SCRATCH:-/leonardo_scratch/large/usertrain/$USER}"
SIF=$SCRATCH/pytorch57.sif
V=$SCRATCH/mw-audit-venv
export TMPDIR=$SCRATCH/.piptmp; mkdir -p "$TMPDIR"

echo "=== net check (does this partition reach HuggingFace/PyPI?) ==="
curl -s -o /dev/null -w "hf_http=%{http_code}\n" --max-time 20 https://pypi.org/simple/ 2>&1 || echo "NET_FAIL"

[ -f "$SIF" ] || { echo "NO pytorch57.sif at $SIF -- run prep-qwen36.slurm first"; exit 1; }
[ -x "$V/bin/python" ] || singularity exec --bind "$SCRATCH" "$SIF" python -m venv --system-site-packages "$V"
singularity exec --bind "$SCRATCH" --env TMPDIR=$SCRATCH/.piptmp,PIP_NO_CACHE_DIR=1 "$SIF" \
  "$V/bin/pip" install transformers==5.9.0 accelerate==1.13.0 safetensors 2>&1 | tail -6

echo "=== verify ==="
singularity exec --bind "$SCRATCH" "$SIF" "$V/bin/python" -c "import transformers,torch;print('AUDIT_VENV_OK',transformers.__version__,torch.__version__)" 2>&1 | tail -2
echo MW_AUDIT_VENV_DONE

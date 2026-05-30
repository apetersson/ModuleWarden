#!/bin/bash
# Leonardo rehearsal: validate huihui model loading + training loop on the
# modern stack (pytorch57.sif + mwenv57b + sft_qwen36.py).
# 1 GPU, 30 min, debug QoS. CRITICAL GATE before full 4-GPU run.
#
# Submit after prep-qwen36 finishes:
#   python leo.py --put rehearsal-diag-v2.slurm '/leonardo/home/usertrain/a08trc02/rehearsal-diag-v2.slurm'
#   LEO_ACCT=2 python leo.py 'sbatch /leonardo/home/usertrain/a08trc02/rehearsal-diag-v2.slurm'
#
#SBATCH --account=euhpc_d30_031
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=1
#SBATCH --mem=120GB
#SBATCH --cpus-per-task=8
#SBATCH --time=0:30:00
#SBATCH --job-name=mw-reh-diag-v2
#SBATCH --output=%x-%j.out

set -x
SCRATCH=/leonardo_scratch/large/usertrain/a08trc02
export HF_HOME="$SCRATCH/hf"
export TRANSFORMERS_OFFLINE=1 HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1

echo "=== host $(hostname) gpu ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# Modern stack (containerless): module load python/3.11.7 + mwenv57b venv.
# No Singularity needed - venv was built directly on lrd_all_serial partition.

# Load Python environment
module load python/3.11.7

# Activate venv
source "$SCRATCH/mwenv57b/bin/activate"

# Model already on scratch
export MWMODEL="$SCRATCH/models/huihui-qwen3.6-27b-abliterated"
export MWCORPUS="${MWCORPUS:-$SCRATCH/sft-records-diagnosis.jsonl}"

# If corpus not yet uploaded, generate a tiny synthetic one
if [ ! -f "$MWCORPUS" ]; then
  echo "WARNING: corpus not found at $MWCORPUS, generating synthetic rehearsal data"
  python3 -c "
import json, sys
system_msg = 'You are ModuleWarden vulnerability diagnosis model. Given an AuditDossier, return a Diagnosis JSON.'
records = []
for i in range(10):
    dossier = {'schema_version':'modulewarden.audit_dossier.v1','audit_id':f'reh_{i:03d}','audit_mode':'version_diff','ecosystem':'npm','package':{'name':f'reh-pkg-{i}','candidate_version':'1.0.0','candidate_integrity':'sha512-fake','candidate_tarball_sha256':'fake','published_at':'2026-01-01T00:00:00Z'},'baseline':{'type':'previous_allowed','version':'0.9.0','integrity':None,'tarball_sha256':None,'decision_id':None},'release_context':{'semver_delta':'minor','declared_package_purpose':'Rehearsal stub','readme_summary':'Stub','changelog_summary':'No changelog available.','repository_url':None,'source_tarball_mismatch':False},'diff_summary':{'files_added':0,'files_modified':0,'files_removed':0,'notable_file_changes':[]},'dependency_changes':[],'capability_deltas':[],'dynamic_observations':{'install_trace_refs':[],'import_trace_refs':[],'network_trace_refs':[]},'evidence_index':[{'id':'ev.meta.001','kind':'scraped_case','path':None,'summary':'Rehearsal stub.','raw_excerpt_available':False}],'policy_context':{'cold_start':False,'conservative_default':'quarantine_on_uncertainty','forbidden_output':[]}}
    diagnosis = {'schema_version':'modulewarden.diagnosis.v1','verdict':'NO_ISSUES_FOUND','issue':None,'evidence_refs':[]}
    rec = {'schema_version':'modulewarden.sft_record.v1','record_id':f'reh_{i:03d}','split':'train','source':'manual_golden','messages':[{'role':'system','content':system_msg},{'role':'user','content':json.dumps(dossier)},{'role':'assistant','content':json.dumps(diagnosis)}]}
    records.append(rec)
with open('$MWCORPUS','w') as f:
    for r in records:
        f.write(json.dumps(r) + '\n')
print('wrote', len(records), 'synthetic records')
"
fi

RECORDS=$(wc -l < "$MWCORPUS")
echo "Corpus records: $RECORDS"

# Rehearsal: 1 epoch, max 50 steps
export MWOUT="$SCRATCH/rehearsal-diag-adapter"
export MW_EPOCHS=1
export MW_MAX_STEPS=50
export MW_MAX_LEN=2048
export MW_LORA_R=32
export MW_LORA_ALPHA=64
export MW_LORA_DROPOUT=0.0
export MW_GRAD_ACCUM=4

# Ensure code is extracted
cd "$SCRATCH/ModuleWarden" || exit 1

python finetune/python/training/sft_qwen36.py \
  2>&1 | grep -vE "DEBUG|urllib3|filelock|hf_xet|distributed"

RC=${PIPESTATUS[0]}
echo "MW_REHEARSAL_DIAG_V2_RC=$RC"

if [ "$RC" = "0" ]; then
  echo "REHEARSAL PASSED - safe to proceed to full 4-GPU training"
else
  echo "REHEARSAL FAILED with RC=$RC - STOP and investigate"
fi
echo "MW_REHEARSAL_DIAG_V2_DONE"

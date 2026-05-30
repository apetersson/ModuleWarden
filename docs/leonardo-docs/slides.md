# Leonardo Hackathon Slides — Text Extraction

Source: `/Users/andreas/Downloads/immich-20260529_232800`

Note: slide text was extracted from photographed slides. Some low-resolution/obscured code fragments are transcribed with best-effort fidelity.

## 20260529_214718.jpg — SSH Access to Leonardo

```text
SSH Access to Leonardo

Use any of the following login nodes:

ssh your_username@login01-ext.leonardo.cineca.it
ssh your_username@login02-ext.leonardo.cineca.it
ssh your_username@login05-ext.leonardo.cineca.it
ssh your_username@login07-ext.leonardo.cineca.it

(For the hackathon, two factor authentication is not used.)
```

## 20260529_214748.jpg — Pixi Package Manager

```text
Pixi Package Manager

- Fast, modern, and reproducible package manager
- Can install packages from:
  - PyPI (like pip)
  - conda-forge (like conda)
- https://pixi.sh/

Quick intro:
curl -fsSL https://pixi.sh/install.sh | bash
pixi init hello-world
cd hello-world
pixi add python  # install from conda-forge
pixi add --pypi openai  # install from PyPI
pixi run python -c 'print("Hello World!")'
```

## 20260529_214833.jpg — Containers on HPC: Singularity / Apptainer

```text
Containers on HPC: Singularity / Apptainer

Most HPC systems don't run Docker, but Singularity or Apptainer
(which are highly related and behave nearly identically)
https://docs.sylabs.io/guides/latest/user-guide/

Convert Docker containers on Leonardo:
srun --partition=lrd_all_serial --time 04:00:00 --gres=tmpfs:100G --mem=16G --pty singularity pull --name vllm-openai-v0.2.1-cu129.sif docker://docker.io/vllm/vllm-openai:0.2.1-cu129

Run something inside a Singularity container:
singularity exec --nv --bind $SCRATCH:/scratch container.sif python3
```

## 20260529_214941.jpg / 20260529_215103.jpg / 20260529_215423.jpg — Slurm: Job Scheduler, 1 GPU

```bash
#!/bin/bash
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc     # Reservation for the hackathon
#SBATCH --nodes=1                   # Number of nodes
#SBATCH --ntasks-per-node=1         # Number of `srun` tasks executed per node
#SBATCH --gpus-per-task=1           # Number of GPUs (up to 4 on Leonardo)
#SBATCH --mem=120GB                 # Fair share on Leonardo: 120GB * gpus-per-task
#SBATCH --cpus-per-task=8           # Fair share on Leonardo: 8 * gpus-per-task
#SBATCH --time=0:30:00              # Time limit in HH:MM:SS, up to 24:00:00

# Construct run command to execute inside pixi environment:
export RUN_COMMAND="/path/to/pixi run --as-is [--manifest-path pixi_project/pixi.toml]"

$RUN_COMMAND python3 script.py
```

## 20260529_215514.jpg — Slurm: Job Scheduler, 2 GPUs

```bash
#!/bin/bash
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc     # Reservation for the hackathon
#SBATCH --nodes=1                   # Number of nodes
#SBATCH --ntasks-per-node=1         # Number of `srun` tasks executed per node
#SBATCH --gpus-per-task=2           # Number of GPUs (up to 4 on Leonardo)
#SBATCH --mem=240GB                 # Fair share on Leonardo: 120GB * gpus-per-task
#SBATCH --cpus-per-task=16          # Fair share on Leonardo: 8 * gpus-per-task
#SBATCH --time=0:30:00              # Time limit in HH:MM:SS, up to 24:00:00

# Construct command to run container:
export CONTAINER="singularity exec --nv container.sif"

$CONTAINER python3 script.py
```

## 20260529_215524.jpg — Slurm: Job Scheduler, 4 GPUs

```bash
#!/bin/bash
#SBATCH --partition=boost_usr_prod
#SBATCH --reservation=s_tra_ncc     # Reservation for the hackathon
#SBATCH --nodes=1                   # Number of nodes
#SBATCH --ntasks-per-node=1         # Number of `srun` tasks executed per node
#SBATCH --gpus-per-task=4           # Number of GPUs (up to 4 on Leonardo)
#SBATCH --mem=480GB                 # Fair share on Leonardo: 120GB * gpus-per-task
#SBATCH --cpus-per-task=32          # Fair share on Leonardo: 8 * gpus-per-task
#SBATCH --time=0:30:00              # Time limit in HH:MM:SS, up to 24:00:00

# Construct command to run container:
export CONTAINER="singularity exec --nv container.sif"

$CONTAINER python3 script.py
```

## 20260529_215533.jpg — Slurm: Job Scheduler, 2 nodes with 4 GPUs each

The slide emphasizes that the hackathon reservation is for **1 node per team**. For multi-node jobs, remove/comment the reservation line and join the regular queue.

```bash
#!/bin/bash
#SBATCH --partition=boost_usr_prod
# #SBATCH --reservation=s_tra_ncc   # remove reservation for multi-node use
#SBATCH --nodes=2
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-task=4
#SBATCH --mem=480GB
#SBATCH --cpus-per-task=32
#SBATCH --time=0:30:00

# Construct command to run container:
export CONTAINER="singularity exec --nv container.sif"

srun $CONTAINER python3 script.py
```

## 20260529_215543.jpg / 20260529_215654.jpg — Slurm: Useful commands

```bash
# Submit a job:
sbatch job.sh

# Check submitted jobs:
squeue --me

# Look at the output from a job:
cat slurm-<job_id>.out

# Or follow the output as the job runs:
tail -c +0 -f slurm-<job_id>.out

# Cancel job:
scancel <job_id>

# Get a shell at a node while a job is running:
srun --overlap --pty --jobid=<job_id> bash
```

## 20260529_215709.jpg — Leonardo storage and login-node CPU limits

```text
Leonardo

File storage:
Shared storage between all login and compute nodes.

- $HOME: 50 GB limit
- $SCRATCH: Higher limit. Use this for larger files during the hackathon.
  (Files are deleted after 40 days.)
- $PUBLIC: 50 GB limit. Can be used to share files between Leonardo users.
- $FAST and $WORK: Do not use during the hackathon.

Login node CPU time limit:
Processes on login nodes have a 10 minute CPU time limit.
Use this for longer processes:

srun --partition=lrd_all_serial --time 04:00:00 --gres=tmpfs:100G --mem=16G --pty bash
```

## 20260529_215859.jpg — Leonardo internet access

```bash
# Use login nodes for large file downloads.
# Compute nodes do not have internet access.
# As a workaround, set the following environment variables in your Slurm script:

export HTTP_PROXY=http://proxyuser:REDACTED@10.99.0.1:38425
export HTTPS_PROXY=http://proxyuser:REDACTED@10.99.0.1:38425
export http_proxy=http://proxyuser:REDACTED@10.99.0.1:38425
export https_proxy=http://proxyuser:REDACTED@10.99.0.1:38425
```

```text
The proxy will restart every once in a while (due to the 10 min CPU time limit).
TCP connections will drop shortly.
Please only use the proxy for low-bandwidth traffic. Always download large files from the login nodes.
```

## 20260529_215954.jpg / 20260529_220001.jpg — Additional Material

```text
Additional Material

Our HPC Onboarding Kit contains additional information:
- Chapter 5: First steps on LEONARDO
- Chapter 6: Software

https://ai-at.eu/hpc-onboarding/
```

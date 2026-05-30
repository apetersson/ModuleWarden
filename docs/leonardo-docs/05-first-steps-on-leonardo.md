# 5 First Steps on LEONARDO
Source: https://ai-at.eu/hpc-onboarding/chapter-5

---

LEONARDO, hosted at CINECA in Italy, is one of Europe's most powerful pre-exascale supercomputers, built under the EuroHPC Joint Undertaking. It consists of two main compute modules — each optimised for different workloads.

**System Architecture**

-   **Booster Module** – Designed for GPU-intensive applications such as large-scale AI training and deep learning.
    Each node contains **one Intel Ice Lake CPU (32 cores)** and **four NVIDIA A100 GPUs** with **64 GB** of memory each.
    The GPUs are interconnected via **NVLink**, providing high-speed GPU-to-GPU communication, while the CPU connects through **PCIe Gen 4.0**.
-   **DCGP Module (Data-Centric General Purpose)** – Provides CPU-only compute nodes, each with **two Intel Ice Lake CPUs** and **over 100 cores**.
    It is suited for workloads that don't require GPUs, such as classical HPC applications.

The modules are interconnected with **HDR InfiniBand**, enabling extremely fast communication across the cluster.

* * *

**Finding your feet on LEONARDO**

LEONARDO provides three main storage areas for managing your data:

-   `$HOME` – Your personal directory.
    -   Quota: **50 GB**
    -   Backed up daily
    -   Suitable for configuration files, scripts, and small datasets
-   `$WORK` – Shared, project-based storage.
    -   Optimised for high-throughput and large-block I/O
    -   Best used for large input/output files and collaborative work within your project
-   `$SCRATCH` – Temporary local storage.
    -   Files not accessed for **40 days** are automatically deleted
    -   Ideal for temporary computation data and intermediate results

To copy data to your storage on LEONARDO either use the login nodes for smaller amounts of data or the dedicated data mover nodes for larger volumes (transfer times > 10 minutes). The first examples below are from the local machine to LEONARDO and the second examples vice versa.

Copy data to login nodes:

`scp /absolute/path/from/file myuser@login.leonardo.cineca.it:/absolute/path/to/`

`scp myuser@login.leonardo.cineca.it:/absolute/path/from/file /absolute/path/to/`

Copy data to data mover nodes:

`scp /absolute/path/from/file myuser@data.leonardo.cineca.it:/absolute/path/to/`

`scp myuser@data.leonardo.cineca.it:/absolute/path/from/file /absolute/path/to/`

You can check your data usage with:

`cindata`

`cinQuota`

You can check how much compute you have used up or left:

`saldo -b`

* * *

**Submitting Jobs with Slurm**

LEONARDO is accessed through login nodes, which are used for basic tasks such as setting up the environment or transferring data. On login nodes, it is permitted to perform small tasks, provided that they do not exceed 10 minutes of CPU time and are free of charge. Actual computations must run on dedicated compute nodes, that are managed by the Slurm workload manager to ensure fair resource sharing.

Slurm (Simple Linux Utility for Resource Management) allocates access to resources to users for a specified duration, provides a framework for starting, executing and monitoring work and manages resources by handling the queue of pending jobs.

You submit a job by preparing a **job script** — a small text file describing what resources you need and what program to run.

A Slurm job script tells the system **what resources your job needs** and **what commands to run**. It's read by the scheduler before your computation starts.

**Step-by-Step – Overview**

1.  Prepare your script (in `$HOME`): Create a job script slurm with the required `#SBATCH` directives (partition, account, walltime, resources).
2.  Submit it using `sbatch job.slurm`
3.  Check status and monitor progress with commands like `squeue --me` Cancel if necessary with `scancel` .
4.  View logs: inspect the files defined under `--output` and `--error` once the job is finished
5.  Use `saldo -b` to view accounting and resource usage details

**How to write a Slurm script**

The first line `#!/bin/bash` specifies the shell used to interpret the script. Lines starting with `#SBATCH` are **directives to the Slurm scheduler** — they define how much hardware your job requires and how long it should run.

-   `--partition` and `--account` specify where and under which project the job will run.
-   The resource options (`--nodes`, `--gpus-per-task`, `--cpus-per-task`, `--mem`, and `--time`) describe **how many nodes, GPUs, CPUs, memory, and runtime** you need.
-   `--output` and `--error` define files where Slurm will write your program's output and any error messages.
-   The section "Software environment options" explains the available options for setting up your **software environment** — you can load pre-installed modules, activate your own conda environment, or execute your program inside a Singularity container.
-   Finally, the srun command actually **launches your program** across the allocated resources.

In short: the top half of the script asks Slurm for the resources; the bottom half prepares your environment and runs your code.

Here's an example job script for the **Booster module**:

```bash
#!/bin/bash
#SBATCH -J my_job
#SBATCH --partition=boost_usr_prod
#SBATCH --qos=boost_qos_dbg
#SBATCH --account=EUHPC_1234
#SBATCH --time=0:30:00
#SBATCH --nodes=1
#SBATCH --gpus-per-task=1
#SBATCH --ntasks-per-node=1
#SBATCH --mem=120GB
#SBATCH --cpus-per-task=8
#SBATCH --output=multiGPUJob.out
#SBATCH --error=multiGPUJob.err

# Software environment options here (modules, conda, containers)
srun python my_script.py
```

* * *

**Deep Dive:**

To ensure a complete understanding of how this job runs, we'll now dive into the specifics. Here's a detailed, line-by-line explanation of the entire script, covering everything from the resource requests to the final program call.

1.  **Job Identification and management**

`#SBATCH -J my_job`

This sets the name of the job as it appears in the queue and log files.

`#SBATCH --partition=boost_usr_prod`

This specifies the specific group of nodes where the job should run. On LEONARDO, boost_usr_prod the production partition for users.

`#SBATCH --qos=boost_qos_dbg`

This controls the Quality of Service (qos) for a job. QoS categorizes, prioritzes and enforces resource limits for different types of jobs. Here, the job is assigned to the Debugging Queue on the Booster partition. Jobs submitted to the debugging QoS receive a higher priority in the queue, however, on LEONARDO there are strict resource limits: maximum wall-clock-time is 30 minutes and the resources are limited to a maximum of 2 nodes and 8 GPUs per job.

On the Booster partition (boost_usr_prod) on LEONARDO, there are different QoS:

| QoS | #nodes per job | Walltime | Max nodes/cores/GPUs | Priority |
|---|---|---|---|---|
| boost_qos_dbg | 2 nodes | 00:30:00 | 2 / 64 / 8 | 80 |
| boost_qos_bprod | 65 – 256 | 24:00:00 | 256 nodes | 60 |
| boost_qos_lprod | 8 | 4-00:00:00 | 8 / - / 32 | 40 |

`#SBATCH --account=EUHPC_1234`

This specifies the billing account or project to which the consumed compute time will be charged.

`#SBATCH --time=0:30:00`

This specifies the maximum wall-clock- time. If the job exceeds the allocated time (here: 30 minutes), it will be automatically terminated.

2.  **Hardware Resource Request**

`#SBATCH --nodes=1`

This specifies the number of needed nodes.

`#SBATCH --gpus-per-task=1`

This requests the number of GPUs to be allocated to the single task.

`#SBATCH --ntasks-per-node=1`

This defines the number of tasks that Slurm should launch on this node. On GPU nodes, one task per node is best practice; that task can then access multiple GPUs via -gpus-per-task=1. Using several tasks per node can complicate GPU binding.

`#SBATCH --mem=120GB`

This defines how much memory is reserved on the node for this job. On LEONARDO, it is recommended using 120GB * number of GPUs (gpus-per-task).

`#SBATCH --cpus-per-task=8`

This requests the number of CPUs to be assigned to the task. On LEONARDO, it is recommended using 8 * number of GPUs (gpus-per-task).

3.  **Output and Error Logging**

`#SBATCH --output=multiGPUJob.out`

The normal screen output of your program (e.g., log messages, calculation results) is written to the file multiGPUJob.out.

`#SBATCH --error=multiGPUJob.err`

Any error messages, warnings or diagnostic output from your program is written to the file multiGPUJob.err.

**Running and Monitoring Jobs**

To submit the job to the scheduler, use:

`sbatch job.slurm`

To check the status of your running or queued jobs:

`squeue --me`

To cancel a job:

`scancel <JOBID>`

You can view job output and error logs in the files specified by `--output` and `--error` once the job completes.

* * *

**Summary**

-   Prepare and test scripts in `$HOME`
-   Store data in `$WORK` or `$SCRATCH` depending on use case
-   Submit and monitor jobs with **Slurm commands**
-   Use **modules**, **conda**, or **containers** to load software
-   Start with short test jobs using the **debug QoS** before full production runs

With these basics, you're ready to run your first batch job on LEONARDO and explore its world-class computing power.

If you need further information, make sure to visit the **Slurm documentation** and CINECA documentation.

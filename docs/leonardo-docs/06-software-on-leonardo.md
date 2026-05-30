# 6 Software on LEONARDO
Source: https://ai-at.eu/hpc-onboarding/chapter-6

---

Generally speaking, you can set up whatever software you need on your own. Only software that specifically requires root privileges (which is uncommon) can't be user-installed. Also, commercial software requiring a licensing server may not be supported on a supercomputer. In any case, users need to make sure that the license terms for software they install are met.

This chapter has four sections:

1.  Transferring existing projects: For existing projects, you can continue to use your package manager on the supercomputer. This section includes an overview of the most commonly used package managers.
2.  Recommendation for new projects: If you are starting a new project, we recommend to have a look at the Pixi package manager. In this section you can find step-by-step instructions for how to initiate your Pixi project, add Python libraries, download an LLM from Huggingface Hub and use it in a Slurm job.
3.  Containers: If you already use containers (such as Docker images), you can also run them on supercomputers. This section explains how to convert Docker images into Singularity images (Singularity is an HPC-optimised container platform available on Leonardo) and how to run them on Leonardo.
4.  JupyterLab: JupyterLab is a powerful, browser-based notebook interface that's ideal for interactive experimentation. While supercomputers with their job schedulers are not ideal for running interactive software such as JupyterLab, it is still possible to run a JupyterLab in a Slurm job. Find out how in this section.

* * *

### 6.1 Transfering existing projects to Leonardo

If you are already accustomed to a certain workflow or package manager, in many cases you can continue to use it when moving to an HPC cluster. Here are instructions to install some of the most commonly used tools on Leonardo:

**venv and pip**

Python is already installed on Leonardo (version 3.11.7 as of this writing — use `module avail python` to check available versions) and can be activated by running

```
module load python/3.11.7
```

You can then create a venv and install packages normally:

```
python -m venv my_venv
source my_venv/bin/activate
pip install -r requirements.txt
```

**Conda**

You can install micromamba (a single-file drop-in replacement for conda) yourself:

```
curl -fLsS micro.mamba.pm/install.sh | sh
```

Alternatively, if you prefer to have the original conda, you can also install it (Miniforge is a conda installer that comes with the conda-forge repository pre-configured):

```
curl -LO "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh"
bash Miniforge3-Linux-x86_64.sh
```

**uv**

You can install uv yourself:

```
curl -fLsS https://astral.sh/uv/install.sh | sh
```

**Pixi**

You can install Pixi yourself:

```
curl -fLsS https://pixi.sh/install.sh | sh
```

### 6.2 Recommendation for new projects

If you are starting a new project, we recommend to use **Pixi**, a fast, flexible and modern package manager. (By the way, if you've heard of uv, uv and Pixi are very similar in spirit, with the main difference being that uv can only install packages from PyPI, whereas Pixi can install packages from both conda-forge and PyPI. For PyPI-packages, Pixi even uses uv's engine as backend.)

In the Python ecosystem, two distinct repositories (and corresponding package management software) are commonly used:

-   The **Python Package Index (PyPI)** is the primary source for Python packages. Packages are often installed using pip. This repository contains lots of Python libraries, but it cannot be used to install the Python interpreter itself or other complementary software (e.g. a compiler).
-   The **conda-forge** repository is the most comprehensive package repository for the conda package manager. The main advantage of conda is that it can not only install Python libraries, but also other software, including the Python interpreter itself, compilers and other languages like R.

Pixi can install software from both conda-forge and PyPI. While it is possible to mix and match software from conda-forge and PyPI, our recommendation is to install only the Python interpreter itself from conda-forge and get any Python libraries from PyPI. While conda-forge packages do have their merits, PyPI packages are more commonly used and dependency resolution is often simpler if all libraries are installed from the same repository.

Pixi is a workspace-based package manager, unlike conda or Python's venv, which create environments in a folder separate from the project files. By default, Pixi creates project-specific environments in the project folder itself (in a hidden subdirectory called `.pixi`) next to the Slurm and Python scripts of the project. The environment specifications are saved in a text file called `pixi.toml`, with the specific versions of all dependencies recorded in `pixi.lock`. This approach keeps software dependencies next to the project files, making setups more portable. Common practice is to keep the `pixi.toml` and `pixi.lock` files in the same git repository as the other project files and to add the environment itself (`.pixi/*`) to `.gitignore`, as the exact environment can be recreated any time by simply running `pixi install` in the project directory.

First, you need to install Pixi itself:

```
curl -fsSL https://pixi.sh/install.sh | sh
source ~/.bashrc
```

Next, create a new directory for your project. On Leonardo, a good place to put it is the `$WORK` directory, which by default offers 1 TB of disk space (compared to 50 GB in `$HOME` — see the Leonardo documentation for a complete list of available directories).

```
cd $WORK
mkdir my_first_project
cd my_first_project
```

Next, initialise the Pixi project (which creates a `pixi.toml` file and adds the `.pixi` folder to `.gitignore`), add the Python interpreter from conda-forge and the PyTorch and Huggingface Transformers libraries from PyPI:

```
pixi init
pixi add python=3.13
pixi add --pypi torch transformers
```

By default, `pixi add` pulls packages from the conda-forge repository, with the `--pypi` option switching to the PyPI repository. You now have a workspace with Python, PyTorch and Huggingface Transformers installed. To run a command in this workspace, execute

```
pixi run <command>
```

For example, to let Python print the words "Hello world!", execute

```
pixi run python -c "print('Hello world!')"
```

On Leonardo, compute nodes (with GPUs) do not have direct access to the internet. You therefore need to download any models and data in advance. You can use the `hf` utility on the login node to download a model from the Huggingface library, e.g.:

```
pixi run hf download LiquidAI/LFM2-350M
```

Next, let's create a small Python script that uses the model to solve a simple equation. You can use e.g. the `nano` text editor or connect Visual Studio Code with Leonardo:

```
nano llm_solve_equation.py
```

Copy and paste the following code:

```python
# Load transformers library:
from transformers import pipeline

# Load model and create a pipeline:
pipe = pipeline("text-generation", model="LiquidAI/LFM2-350M", device="cuda:0")

# Ask the question
prompt = "Solve the equation 2x + 3 = 7. Please reason step by step, and put your final answer within \\boxed{}."

# Generate the answer and print the model's response:
result = pipe(prompt, max_new_tokens=256)
print(result[0]["generated_text"])
```

Next, we need to create a Slurm script that requests 1 GPU from the scheduler and execute `llm_solve_equation.py`:

```
nano run_llm_solve_equation.slurm
```

Copy and paste the following code:

```bash
#!/bin/bash
# Job Identification and Management
#--------------------------------------
#SBATCH --partition=boost_usr_prod
#SBATCH --qos=boost_qos_dbg
#SBATCH --time=0:30:00

# Resource Request (Hardware)
#--------------------------------------
#SBATCH --nodes=1
#SBATCH --gpus-per-task=1 # up to 4 on LEONARDO
#SBATCH --ntasks-per-node=1 # always 1
#SBATCH --mem=120GB # should be 120GB * gpus-per-task on LEONARDO
#SBATCH --cpus-per-task=8 # should be 8 * gpus-per-task on LEONARDO

# Compute nodes on LEONARDO have no direct access to the internet.
# Tell transformers to load model from disk cache only:
export TRANSFORMERS_OFFLINE=1
# Run the application in the environment prepared by Pixi:
pixi run python llm_solve_equation.py
```

Finally, submit the job to the scheduler using

```
sbatch run_llm_solve_equation.slurm
```

You can now have a look at the jobs that are currently in the queue using `squeue --me`.

Once the job finished, it will disappear from the queue and you will find the output in a file called `slurm-<JOBID>.out`.

Congratulations, you now installed your own Pixi environment, downloaded a model from Huggingface Hub and ran your first Slurm job that loaded and queried this model!

Finally, here are some additional notes concerning cache files and CUDA:

-   **Cache files and disk quota on Leonardo:** Both Pixi and the Huggingface libraries save their cache in `$HOME/.cache`, which is subject to the 50 GB quota for `$HOME` on Leonardo. To avoid filling up your precious `$HOME` quota, we recommend to move the cache to `$WORK`, where the default quota is 1 TB, and link it back to the original location. You can do so with these two commands (please be patient, it may take a couple of minutes to move the folder):

```
mv $HOME/.cache $WORK/$USER-.cache
ln -s $WORK/$USER-.cache $HOME/.cache
```

Note that on Leonardo `$HOME` is user-specific, while `$WORK` is shared between the users of a project.

-   **Installing CUDA-enabled packages from conda-forge:** With the PyPI repo, installing CUDA-enabled packages is straight-forward, as PyPI usually contains only one package of a particular library, which often already supports CUDA (e.g. the PyTorch package in PyPI supports CUDA). Conda-forge, however, often contains multiple packages, e.g. one of which may offer CUDA support and another one may be CPU-only. Conda and Pixi automatically select the version depending on if a GPU is available during install time. On the cluster however, you will probably prepare the environment on a GPU-less login node, but still want it to make use of GPUs later on when the software runs on the GPU-equipped compute nodes. You can force pixi to install the CUDA-enabled packages by configuring the workspace setting `system-requirements` to be `cuda` (necessary only once per project) and the environment variable `CONDA_OVERRIDE_CUDA=12` (which needs to be set every time you add a CUDA-enabled package from conda-forge):

```
pixi workspace system-requirements add cuda 12
CONDA_OVERRIDE_CUDA=12 pixi add cuda_enabled_conda_package
```

-   **CUDA and PyTorch from PyPI:** The torch package from PyPI already contains the necessary parts of the Nvidia CUDA toolkit, so generally it is not necessary to install the CUDA toolkit separately. For a few select use cases though (e.g. libraries that compile part of the code with `nvcc` during run time) this may not suffice. It may be necessary to install the full CUDA toolkit from conda-forge using:

```
pixi workspace system-requirements add cuda 12
CONDA_OVERRIDE_CUDA=12 pixi add cuda-toolkit=12.8
```

Make sure to install the same minor version of the CUDA toolkit that is also included in the PyPI torch package. You can find out which CUDA runtime was installed by inspecting the list of installed packages using `pixi list`. Alternatively, you may also install PyTorch from conda-forge instead of from PyPI, which will lead to only one more complete instead of two instances of the CUDA toolkit installed.

```
pixi remove --pypi torch
CONDA_OVERRIDE_CUDA=12 pixi install pytorch
```

This is something that we only recommend for experts though, as dependency resolution may need to be performed partly manually when mixing Python libraries from conda-forge and PyPI.

### 6.3 Containers

If you are already working with containers (such as Docker images) you can also run them on the HPC cluster. However, most supercomputers use Singularity/Apptainer instead of Docker, because it is specifically optimised for HPC environments. To use containers on Leonardo, start by building a Singularity image. The resulting `.sif` file is a single, self-contained file that can be transferred easily between machines and executed directly on the cluster.

Note: Singularity has been forked, resulting in three closely related implementations: SingularityCE (Community Edition), SingularityPRO and Apptainer. For the majority of use-cases, these three tools behave virtually identically, so you generally don't need to worry which one is installed on the supercomputer you're using.

**Pull a Docker image from a registry**

The easiest way to get a Singularity image on Leonardo is to pull a Docker image from a container registry. It can be either a pre-built Docker image, or you can build your own Docker image using your preferred Docker tooling on any machine (outside of Leonardo) and push the Docker image to a container registry (e.g. Docker Hub or GitHub Container Registry). You can then pull the image into Singularity using `singularity pull <name>.sif docker://<user>/<image>:<tag>` directly on the cluster. As this process can take a few minutes, don't run it directly on the login node, but through the Slurm scheduler on the `lrd_all_serial` partition, which has internet access and is not subject to the strict resource limits of the login node:

```
time srun --partition=lrd_all_serial --time 04:00:00 --gres=tmpfs:100G --mem=16G --pty singularity pull transformers.sif docker://huggingface/transformers-pytorch-gpu
```

Next, we will use the same Python script as in the Pixi example:

```python
# Load transformers library:
from transformers import pipeline

# Load model and create a pipeline:
pipe = pipeline("text-generation", model="LiquidAI/LFM2-350M", device="cuda:0")

# Ask the question
prompt = "Solve the equation 2x + 3 = 7. Please reason step by step, and put your final answer within \\boxed{}."

# Generate the answer and print the model's response:
result = pipe(prompt, max_new_tokens=256)
print(result[0]["generated_text"])
```

We need to create a Slurm script that requests 1 GPU from the scheduler and executes `llm_solve_equation.py` in the Singularity container:

```bash
#!/bin/bash
# Job Identification and Management
#--------------------------------------
#SBATCH --partition=boost_usr_prod
#SBATCH --qos=boost_qos_dbg
#SBATCH --time=0:30:00

# Resource Request (Hardware)
#--------------------------------------
#SBATCH --nodes=1
#SBATCH --gpus-per-task=1 # up to 4 on LEONARDO
#SBATCH --ntasks-per-node=1 # always 1
#SBATCH --mem=120GB # should be 120GB * gpus-per-task on LEONARDO
#SBATCH --cpus-per-task=8 # should be 8 * gpus-per-task on LEONARDO

# Compute nodes on LEONARDO have no direct access to the internet.
# Tell transformers to load model from disk cache only:
export TRANSFORMERS_OFFLINE=1
# Run the application in the Singularity container:
singularity exec --nv --bind /leonardo_work,/leonardo_scratch transformers.sif python3 llm_solve_equation.py
```

Finally, submit the job to the scheduler using

```
sbatch run_llm_solve_equation.slurm
```

You need to wait for the job to run. Once the job finished, you can find the output in a file called `slurm-<JOBID>.out`.

**Build a Singularity container from a Singularity definition file**

Alternatively, you can also build Singularity images from Singularity definition files. You can find a description of the format in the manual. It is not possible to build Singularity images from definition files directly on Leonardo, but you can use the remote builder hosted on infrastructure run by Sylabs (the creators of Singularity).

* * *

### 6.4 JupyterLab

JupyterLab provides a powerful, browser-based notebook interface that's ideal for interactive experimentation. (In case you are wondering, Google Colab builds on the same JupyterLab foundation.)

Because HPC schedulers are optimised to maximise resource utilization, HPC systems don't naturally lend themselves to interactive GPU workloads. Nevertheless, you can still launch a JupyterLab session inside a Slurm job on Leonardo. Bear in mind that you will have to wait for the Slurm job to start before you can access your JupyterLab. Also, as compute nodes on Leonardo are not directly exposed to the public internet, you first need to set up an ssh port forwarding tunnel so that you can access the JupyterLab in your browser. Here is a quick overview of the steps.

First, create a new Pixi workspace with Python and JupyterLab:

```
cd $WORK
mkdir jupyterlab
cd jupyterlab
pixi init
pixi add python=3.13
pixi add --pypi jupyterlab
```

Next, create a Slurm file that requests one GPU for 30 minutes (in the debug queue, which has higher priority, so that we don't need to wait so long) and starts the JupyterLab. If you are using the default queue with longer wait times, you can use the options `--mail-type` and `--mail-user` to instruct the scheduler to notify you via email that the job started.

```bash
#!/bin/bash
# Job Identification and Management
#--------------------------------------
#SBATCH --partition=boost_usr_prod
#SBATCH --qos=boost_qos_dbg
#SBATCH --time=0:30:00

# Resource Request (Hardware)
#--------------------------------------
#SBATCH --nodes=1
#SBATCH --gpus-per-task=1 # up to 4 on LEONARDO
#SBATCH --ntasks-per-node=1 # always 1
#SBATCH --mem=120GB # should be 120GB * gpus-per-task on LEONARDO
#SBATCH --cpus-per-task=8 # should be 8 * gpus-per-task on LEONARDO

# Instruct Slurm to send you an email once the job started:
#--------------------------------------
#SBATCH --mail-type=BEGIN
#SBATCH --mail-user=your.name@example.com

pixi run jupyter lab --ip 0.0.0.0 --no-browser
```

Submit the job using `sbatch <script.slurm>`.

Once the job started, open the Slurm output file of the job `slurm-<JOBID>.out` and look for an URL similar to

```
http://lrdn3309.leonardo.local:8888/lab?token=a358fb3c7ca7b9e83ab12cf49004fbf45f64e3560e037f15
```

This URL contains three important elements: The hostname of the compute node that the job runs on (`lrdn3309.leonardo.local`), the TCP port that the JupyterLab listens at (`8888`) and the authentication token (`a358fb3c7ca7b9e83ab12cf49004fbf45f64e3560e037f15`). Next, open an additional SSH connection to Leonardo with a port fowarding tunnel to the compute node. Execute the following line, replacing `lrdn3309.leonardo.local` with the compute node that your job runs on and `8888` with the port that your JupyterLab listens on:

```
ssh -N -L 8000:lrdn3309.leonardo.local:8888 login.leonardo.cineca.it
```

The option `-N` tells `ssh` to establish only the port forwarding tunnel, without opening a shell. The option `-L local_port:remote_computer:remote_port` specifies that any connection to `local_port` on the local machine will be securely forwarded to `remote_computer` at `remote_port` through the SSH connection.

After the ssh tunnel is established, you can open the JupyterLab in your browser at the URL http://localhost:8000/. You will be asked for your authentication token — enter the token from the Slurm output file.

Once you are finished, close JupyterLab either by selecting "File" — "Shut Down" from the menu or by cancelling the job using `scancel <JOBID>`. This ensures that the job stops running, preventing unnecessary use of resources after you have finished your work.

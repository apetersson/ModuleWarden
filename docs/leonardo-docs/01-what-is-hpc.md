# 1 What is HPC
Source: https://ai-at.eu/hpc-onboarding/chapter-1/

---

High-Performance Computing, or HPC, refers to the use of powerful supercomputers to perform large-scale calculations far beyond the capacity of a standard laptop or desktop. It enables scientists, engineers, and innovators to solve complex problems that would otherwise take years to compute.

When working with an HPC system, the process typically begins with connecting remotely via ssh (Secure Shell) from your laptop. This secure protocol lets you work on the supercomputer as if you were sitting in front of it. Once connected, you arrive on a login node — a front-end system where you prepare your simulations or training jobs. Heavy computations are not performed here but on dedicated compute nodes.

To manage access to these powerful nodes, HPC systems use a scheduler, such as Slurm. The scheduler acts like a traffic controller, allocating resources fairly among users. You submit your work in a job script, a simple text file describing what you need: how many CPUs or GPUs, how much memory, how long the job should run, and which program to execute. The scheduler then runs your job on the appropriate compute nodes.

These compute nodes are the real engines of the system — each equipped with multiple CPUs or GPUs optimised for parallel computations, ideal for training AI models or running complex simulations.

Behind the scenes, HPC systems use a tiered storage architecture. Fast storage handles active computations, while slower, larger storage areas archive data. There is also a temporary scratch space for short-term files. All parts of the system are linked by a high-speed network, ensuring that data moves rapidly between compute nodes and storage systems.

In essence, an HPC cluster can combine thousands of processors, large memory pools, and fast data connections to to work on one code in parallel. It is key that you know how to parallelize your code.

This is where the expertise from AI Factory Austria AI:AT comes in handy. Make sure you reach out when you need support. The team will gladly help you to tame the compute power available. From logging in, parallelizing your code, and submitting your job to receiving your results, the workflow is designed to give you access to immense computational power — allowing you to tackle challenges that would be impossible to solve on a normal computer.

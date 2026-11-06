---
title: projects
description: Add a project's repositories, prepare its machines with setup scripts, and size them.
---

A project is the repositories its threads check out, plus how their machines are prepared. Every thread belongs to one project. Projects also bound what threads share: a thread reads and revises artifacts and other threads' conversations only within its own project.

## add a project

1. Open **projects** and choose **new project**.
2. Enter a **project name**.
3. Under **repositories**, enter the primary repository. With GitHub connected, type to search your repositories, or paste a git URL. Choosing one fills in an empty project name.
4. Optional: choose **add reference** for more repositories the agent can read, each with its **checkout** name.
5. Choose **save**, then **check**.

The check resolves each repository's branch to a commit and prints the result, or the full error, under the row. **new thread** stays off until the saved project is checked and ready. Saving again makes the project unchecked until the next check.

A private GitHub repository needs GitHub access on the host. If the check cannot read it, the row offers **log in to github**.

## where repositories go in a machine

| repository | path in the thread machine | the agent may |
|---|---|---|
| the primary repository | `/workspace` | change it, commit and push |
| each reference repository | `../repos/<checkout name>`, beside `/workspace` | read it |

Each thread pins every repository at the commit its branch has when the thread starts, and keeps that commit. Two threads of one project never share a checkout.

## prepare machines with setup scripts

A repository can prepare the machines that check it out, with two executable files in the primary repository:

| file | runs | use it for |
|---|---|---|
| `.agents/setup` | once, when a new machine is prepared, in `/workspace` | installing toolchains and dependencies |
| `.agents/resume` | on every boot of a machine, before the agent opens | starting what must run in every boot |

Both run as user `agent` in the machine, with `sudo` available and the machine's network: HTTP and HTTPS to public hosts. Preparation has 30 minutes in total; so does the resume phase. A failing script stops its phase but never fails the thread: the outcome is recorded and shown. Print and time the slow steps, because a starting thread shows the running script's log.

### the first machine of a project is the slow one

The first thread of a project prepares its machine from the image: boot, checkout, setup. cube then keeps what that machine's setup wrote as the project's **template** on that runner. Later threads start from the template in seconds, with `.agents/setup` marked as skipped.

When the template's inputs change, such as the repository's `.agents/setup`, the project's pre-setup hook or the runner's image, the next thread prepares a new template from the start.

## hooks of your own

A project also has two hooks kept in cube, not in the repository: **pre-setup** and **pre-resume**. They run before the repository's scripts. Use them for what belongs to your installation rather than the repository. See [project hooks](/cube/use/project-hooks/).

## machine size

Under **machine size**, set the memory and processors of the project's new thread machines. Empty fields use cubed's defaults: 2 processors and 4096 MiB, unless `CUBED_VM_VCPUS` and `CUBED_VM_MEMORY_MIB` say otherwise. Each runner clamps the size to its own limits. A thread keeps the size it was created with.

If a setup step runs out of memory, the thread says so and suggests a larger machine size.

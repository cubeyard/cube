---
title: skills
description: Instructions thread agents and the chat follow, from git repositories pinned to exact commits and from a repository's own .agents/skills.
---

Skills are instructions an agent reads when a task matches them: how to open a pull request, how to verify a change, how to write a report. Each one is a folder with a `SKILL.md` in the [Agent Skills](https://agentskills.io) format. A thread's prompt lists each skill's name, description and path, and the agent reads a skill only when it needs it.

## where skills come from

| source | what it gives | pinned to |
|---|---|---|
| cube's default, [cubeyard/skills](https://github.com/cubeyard/skills) | the skills cube ships with | the commit this cube release names, or one you chose |
| your own sources, in order | skills of your own, or replacements for default ones | the commit you give |
| the project's primary repository, `.agents/skills/<id>/SKILL.md` | skills of that repository | the commit the thread starts from |

A skill's id is its folder's name. For each id the last source that has it wins, so a source of your own with a folder of the same name replaces a default skill. A repository's own skill wins over both.

A thread's skills are fixed when it starts. A change in the settings never changes a started thread.

## manage skills

Open **settings** › **skills**. The page lists:

- the sources, which you can add and remove,
- the skills new threads get, with their source, which you can disable and enable,
- folders that were skipped, with the reason.

A source is an `https` git URL without credentials, a full 40-character commit (never a branch or tag), and the directory that holds the skill folders. The page saves only a configuration that resolves.

### update the default skills

**check for update** fetches cubeyard/skills and shows its newest commit and which skills new threads would gain, lose or get changed. It saves nothing. **use @&lt;commit&gt;** saves exactly that commit. No branch is ever followed.

## which agent gets a skill

A skill's `metadata.cube.surface` in its frontmatter says which agent gets it:

| surface | thread | chat |
|---|---|---|
| `thread` (the default) | listed | not listed |
| `optchat` | installed, not listed | listed |
| `both` | listed | listed |

A skill with `disable-model-invocation: true` is installed but not listed.

## the repository's own skills

Skills in the primary repository's `.agents/skills` are not installed: the checkout already has them, so the prompt points at `/workspace/.agents/skills/<id>/SKILL.md`. A skill added in a thread's own branch is listed only from the next thread on.

## trust

A skill is text an agent follows. It adds no tool and no permission, but nothing stops it from asking the agent to use the tools it has, as your own words could. Add only sources you trust. Each thread installs at most 64 skills.

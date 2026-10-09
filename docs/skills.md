# Skills

A thread's agent (Pi or Claude Code) gets skills: folders in the
[Agent Skills](https://agentskills.io) format, each a `SKILL.md` with `name`
and `description` frontmatter plus the files it links. They come from git
repositories, each pinned to one exact commit. OptChat does not read skills
yet. Code: `packages/server/src/skills.ts`.

## Sources and precedence

```text
cubeyard/skills @ d5041ce9ae3af0c5b0dbb00234a2bd600df8cf63   cube's default (a release moves the pin)
your sources, in order                                       settings.json: skills.sources
```

- A source is `{url, commit, path}`: an `https` git URL, a full 40-character
  commit (never a branch or tag) and the directory holding skill folders
  (`<path>/<name>/SKILL.md`; empty for the repository root).
- For each skill name, **the last source that has it wins**, whatever its
  surface. To change one default skill without forking, add a source with a
  skill of the same name. The winner records the source it overrides.
- `skills.disabled` lists names that are left out after precedence.
- Folders are read in name order. A thread lists its skills sorted by name.

## Surface

`metadata.cube.surface` in the frontmatter says which agent gets the skill.

| value | thread prompt | OptChat |
| --- | --- | --- |
| `thread` (default) | listed | not listed |
| `optchat` | installed, not listed | deferred |
| `both` | listed | deferred |

A skill with `disable-model-invocation: true` is installed but not listed.

## When a thread starts

```mermaid
sequenceDiagram
  participant H as cubed (host)
  participant M as thread machine
  H->>H: resolve sources at their commits (host mirror, git ls-tree / cat-file)
  H->>H: winners + provenance -> allocation.skills (fixed for the thread)
  H->>M: per source: git fetch --depth 1 <url> <commit>; git archive <commit>:<dir> into ~/.cube/skills.next/<name>
  H->>M: replace ~/.cube/skills with ~/.cube/skills.next
  H->>M: checkout, pre-setup, .agents/setup (as before)
  H->>H: open the agent; its prompt lists name, description, SKILL.md path
```

- Skills resolve beside the repositories' latest commits. A source that
  cannot be read fails the start, like an unreachable repository; one the
  machine cannot fetch fails its preparation step, which cube tries again. A
  later settings change never changes a started thread.
- Every winning skill is installed as `/home/agent/.cube/skills/<name>/`, so
  a link from one skill to `../<other>/SKILL.md` keeps working and reaches
  the winning `<other>`. A link that leaves the skills directory does not.
- Progressive disclosure: the prompt has names, descriptions and paths only.
  The agent reads a `SKILL.md` when a task matches, and its linked files when
  it needs them. Pi gets the list as a prompt section, Claude Code through
  its mod (`CUBE_SKILLS_PROMPT`), the same text for both.
- Threads created before skills have no `allocation.skills` and get none.

## Checks and limits

A folder is skipped, with its reason in `skipped`, when its name is not a
skill name (lowercase letters, digits, inner hyphens, at most 64), its
`SKILL.md` names another skill, its description is empty or over 1024
characters, its surface is unknown, or it holds a symlink or submodule. A
thread installs at most 64 skills, 2000 files and 8 MiB.

Skills are instructions the agent follows and files it may run, in its own
machine only, the same trust as the repository's own files. Add only sources
you trust. Nothing here limits what the agent may do; the machine is the
sandbox (docs/security.md).

## Settings

`GET /api/settings/skills` resolves the saved sources and returns
`{default, saved, resolved: {sources, skills, skipped}}`.
`PUT /api/settings/skills {sources, disabled}` saves only a configuration
that resolves (400 for a malformed one, 422 for one that does not resolve).
It is kept in `<CUBED_STATE>/settings.json` under `skills`. There is no
settings page for skills yet.

```sh
curl -X PUT http://127.0.0.1:7777/api/settings/skills -H 'content-type: application/json' -d '{
  "sources": [{"url": "https://github.com/me/my-skills", "commit": "<40-character commit>", "path": "skills"}],
  "disabled": ["briefing-a-thread"]
}'
```

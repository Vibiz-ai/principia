# Principia Marketplace

Open **Marketplace** in the desktop sidebar to browse workflows, scripts, skills and subagents. Search by task, filter by use case or show installed items. Select a card to inspect its steps, agent prompts, commands or complete skill text before installing it.

Workflow installation adds an editable copy to Workflows; it does not run it or create a schedule. Template agent profiles map to your available workspace profiles. Review the profile and inputs before running. Scripts may require local tools such as Python, Node or macOS `sips`; inspect the displayed commands.

Skills currently install to `~/.claude/skills/<id>/SKILL.md` and subagents to `~/.claude/agents/<id>.md`. They are available to new Claude Code sessions. This release does not install skills for Codex. An existing file is only replaced after choosing **Replace** in the preview. Installed workflow detection uses its catalog name, so a renamed copy will no longer show an Installed badge.

## Share a capability

Use **Contribute** in Marketplace to propose an item on GitHub, or open a pull request:

1. Add a workflow export (`.hive.json`) under `workflows/` or `scripts/`, or a Markdown file under `agents/` or `skills/<id>/SKILL.md`.
2. Add its metadata to `index.json`. Use a unique lowercase slug, a clear outcome, relevant tags, your author name and any required key names. Never include key values, private paths, customer data or transcripts.
3. Include concrete sample inputs, expected output and how you tested it. State which agent or local dependencies it requires and any external side effects.
4. Run `npx vitest run src/main/__tests__/marketplace.test.ts` and submit your PR. Maintainers review the files before merging them into the built-in catalog. Existing installations receive built-in changes with the next application build.

Use tags such as `operations`, `meetings`, `planning`, `marketing`, `sales`, `customers`, `research`, `data`, `scraping`, `api`, `design`, `image`, `content`, `coding`, `tests` or `review` to appear in the corresponding use-case filter.

Minimal skill entry:

```json
{
  "id": "meeting-actions",
  "kind": "skill",
  "name": "Meeting action planner",
  "description": "Extract decisions, owners and follow-ups from meeting notes.",
  "tags": ["operations", "meetings"],
  "author": "Your name",
  "path": "skills/meeting-actions/SKILL.md"
}
```

Markdown files must include YAML front matter with `name` and `description`. This installer supports a single Markdown file, not skill packages with additional scripts or assets.

## Host your own catalog

Publish an HTTPS `index.json` using the same format as this directory. Go to **Settings → Data → Marketplace URL**, paste its URL, then refresh Marketplace. Built-in items remain available if the remote catalog cannot load.

```json
{
  "hive": "marketplace",
  "version": 1,
  "name": "Our company library",
  "items": []
}
```

The `hive` field and `.hive.json` extension are retained for file compatibility. Item paths resolve relative to the index URL, or may be absolute HTTPS URLs. Remote catalogs are labelled separately; their author names are supplied by the catalog and are not verified identities. Only connect catalogs you trust. Nothing is published or automatically installed when a catalog is added.

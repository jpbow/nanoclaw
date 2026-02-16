---
name: add-github
description: Add GitHub MCP tools (issues, PRs, repos, code search) via the GitHub Copilot cloud MCP server. Gives container agents access to GitHub tools.
---

# Add GitHub MCP Server

This skill adds the GitHub Copilot cloud MCP server to NanoClaw container agents, giving them tools for issues, PRs, repos, code search, and more.

**MCP Server URL:** `https://api.githubcopilot.com/mcp/`

## Step 1: Get GitHub Personal Access Token

Ask the user:

> I need a GitHub Personal Access Token to authenticate with the GitHub MCP server.
>
> You can create one at: **https://github.com/settings/tokens**
>
> Create a **Fine-grained token** or **Classic token** with the scopes you want the agent to have (e.g., `repo`, `issues`, `pull_requests`).
>
> Paste your token and I'll add it to `.env`.

## Step 2: Add Token to .env

Add `GITHUB_TOKEN` to the project `.env` file:

```
GITHUB_TOKEN=<the token the user provided>
```

## Step 3: Add GITHUB_TOKEN to Container Secrets

In `src/container-runner.ts`, find the `readSecrets()` function and add `'GITHUB_TOKEN'` to the allowlist array:

```typescript
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']);
}
```

## Step 4: Configure MCP Server in Container Settings

In `src/container-runner.ts`, find where `settingsFile` is written (the `if (!fs.existsSync(settingsFile))` block). Update the settings JSON to include the GitHub MCP server:

```typescript
fs.writeFileSync(settingsFile, JSON.stringify({
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
  mcpServers: {
    github: {
      url: 'https://api.githubcopilot.com/mcp/',
      headers: {
        Authorization: 'Bearer ${GITHUB_TOKEN}',
      },
    },
  },
}, null, 2) + '\n');
```

**IMPORTANT:** The token placeholder `${GITHUB_TOKEN}` is a literal string — Claude Code's MCP config supports environment variable interpolation in headers. The actual token value comes from the container's environment via the secrets mechanism.

## Step 5: Force Settings Refresh

Existing groups already have a `settings.json` that won't be overwritten (due to the `if (!fs.existsSync(settingsFile))` guard). Delete existing settings files so they get recreated on next container run:

```bash
find data/sessions -name settings.json -delete 2>/dev/null
```

## Step 6: Update CLAUDE.md

Add `add-github` to the Skills table in the project `CLAUDE.md`:

```
| `/add-github` | Add GitHub MCP tools (issues, PRs, repos) via GitHub Copilot MCP server |
```

## Step 7: Verify

Tell the user:

> GitHub MCP server has been configured. On the next container agent run, the agent will have access to GitHub tools (issues, PRs, repos, code search, etc.).
>
> You can test it by asking your agent something like: "@Andy list my open GitHub issues in <repo>"

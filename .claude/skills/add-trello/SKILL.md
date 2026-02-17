---
name: add-trello
description: Add Trello MCP tools (boards, lists, cards, checklists, comments) via the mcp-server-trello package. Gives container agents access to Trello project management tools. Triggers on "add trello", "trello integration", "setup trello", "trello".
---

# Add Trello MCP Server

This skill adds the `@delorenj/mcp-server-trello` MCP server to NanoClaw container agents, giving them tools for managing Trello boards, lists, cards, checklists, comments, and attachments.

**MCP Server:** `@delorenj/mcp-server-trello`
**GitHub:** https://github.com/delorenj/mcp-server-trello

## Step 1: Get Trello Credentials

Ask the user:

> I need two things from Trello to set up the integration:
>
> **1. API Key:**
> - Go to https://trello.com/power-ups/admin (sign in if needed)
> - Click on an existing Power-Up, or create a new one (name it "NanoClaw", pick any workspace)
> - Once created, go to the Power-Up's page and click **Generate a new API key** (or find the existing one)
> - Copy the **API Key**
>
> **2. Token:**
> - After you give me the API key, I'll generate the authorization URL for you
>
> Paste your API key and I'll continue.

Wait for the user to provide the API key.

Once you have the API key, tell the user:

> Now authorize the app to access your Trello account. Open this URL in your browser:
>
> `https://trello.com/1/authorize?expiration=never&name=NanoClaw&scope=read,write&response_type=token&key=YOUR_API_KEY`
>
> (Replace `YOUR_API_KEY` with the actual key, or construct the URL yourself.)
>
> Click **Allow**, then copy the token that appears on the page.

Wait for the user to provide the token.

## Step 2: Add Credentials to .env

Add `TRELLO_API_KEY` and `TRELLO_TOKEN` to the project `.env` file:

```
TRELLO_API_KEY=<the api key the user provided>
TRELLO_TOKEN=<the token the user provided>
```

## Step 3: Add Trello Secrets to Container

In `src/container-runner.ts`, find the `readSecrets()` function and add `'TRELLO_API_KEY'` and `'TRELLO_TOKEN'` to the allowlist array:

```typescript
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN']);
}
```

## Step 4: Configure MCP Server in Agent Runner

In `container/agent-runner/src/index.ts`, find the `mcpServers` object inside the `query()` call (where the GitHub MCP server is configured). Add a conditional Trello entry alongside GitHub:

```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: { /* ... */ },
  },
  ...(sdkEnv.GITHUB_TOKEN ? {
    github: { /* ... */ },
  } : {}),
  ...(sdkEnv.TRELLO_API_KEY && sdkEnv.TRELLO_TOKEN ? {
    trello: {
      command: 'npx',
      args: ['-y', '@delorenj/mcp-server-trello'],
      env: {
        TRELLO_API_KEY: sdkEnv.TRELLO_API_KEY,
        TRELLO_TOKEN: sdkEnv.TRELLO_TOKEN,
      },
    },
  } : {}),
},
```

Also add `'mcp__trello__*'` to the `allowedTools` array in the same `query()` call.

## Step 5: Rebuild Container and Restart

Rebuild the container image (required since agent-runner code changed):

```bash
cd container && ./build.sh
```

Wait for build to complete, then compile the host TypeScript:

```bash
cd .. && npm run build
```

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Step 6: Verify

Tell the user:

> Trello integration is configured! On the next container agent run, the agent will have access to Trello tools.
>
> Test it by sending a message like:
> - `@Bob list my Trello boards`
> - `@Bob what cards are on my board?`
> - `@Bob add a card to the To Do list called "Test card"`

## Troubleshooting

### MCP server not connecting
- Check that `TRELLO_API_KEY` and `TRELLO_TOKEN` are in `.env`
- Verify secrets are in `readSecrets()` allowlist in `src/container-runner.ts`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

### "unauthorized" or "invalid token" errors
- Verify API key at https://trello.com/power-ups/admin
- Regenerate token using the authorization URL
- Ensure token has `read,write` scope

### Tools not appearing
- Verify `mcp__trello__*` is in the `allowedTools` array in `container/agent-runner/src/index.ts`
- Verify the `trello` entry is in the `mcpServers` object
- Rebuild the container: `cd container && ./build.sh`
- Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Board not found
- The agent needs to call `list_boards` first to discover available boards
- Then `set_active_board` to select one
- Alternatively, pass `boardId` directly to tool calls

## Removal

To remove Trello integration:

1. Remove `trello` from `mcpServers` and `'mcp__trello__*'` from `allowedTools` in `container/agent-runner/src/index.ts`
2. Remove `'TRELLO_API_KEY'` and `'TRELLO_TOKEN'` from `readSecrets()` in `src/container-runner.ts`
3. Remove `TRELLO_API_KEY` and `TRELLO_TOKEN` from `.env`
4. Rebuild: `cd container && ./build.sh && cd .. && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

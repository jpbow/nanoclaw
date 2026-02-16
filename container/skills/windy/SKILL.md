---
name: windy
description: Show weather map screenshot from Windy.com for any location. Triggered by "windy" followed by a location name or coordinates.
allowed-tools: Bash(agent-browser:*), mcp__nanoclaw__send_image
---

# Windy Weather Screenshot

Take a screenshot of the Windy.com weather map for a location and send it to the user.

## Steps

1. **Parse location**: Extract the location from the user's message (e.g., "windy christchurch" → "christchurch")

2. **Geocode to coordinates**: Use the Windy URL format with the location name. Windy accepts URLs like:
   - `https://www.windy.com/Christchurch` (city name)
   - `https://www.windy.com/-43.532/172.637` (lat/lon)

   If the user provides a city name, search for its approximate lat/lon coordinates from your knowledge and use the coordinate format for reliability.

3. **Open Windy in browser**:
   ```bash
   agent-browser open "https://www.windy.com/{lat}/{lon}?zoom=8"
   ```

4. **Wait for the map to render**:
   ```bash
   agent-browser wait 5000
   ```

5. **Dismiss any popups/cookie banners** (if present):
   ```bash
   agent-browser snapshot -i
   # Look for cookie/consent buttons and click them if found
   ```

6. **Take screenshot**:
   ```bash
   agent-browser screenshot /workspace/ipc/media/windy.png
   ```

7. **Send the image** using the `send_image` MCP tool:
   - path: `/workspace/ipc/media/windy.png`
   - caption: "Weather map for {location}"

8. **Close browser**:
   ```bash
   agent-browser close
   ```

## Important

- Create the media directory first: `mkdir -p /workspace/ipc/media`
- Always close the browser when done
- If the map hasn't loaded after waiting, try waiting a bit longer
- Use zoom level 8-10 for city-level views

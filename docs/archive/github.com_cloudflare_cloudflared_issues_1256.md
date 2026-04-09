💡 A mechanism to retrieve the currently running quick tunnels · Issue #1256 · cloudflare/cloudflared · GitHub

Describe the feature you'd like
When you startup a quick tunnel, it's difficult to access the current URL for that tunnel. This makes it difficult to create dev scripts using tunnels.

Describe alternatives you've considered
Shopify's CLI uses tunnels as part of their development workflow, but the only way it looks like they could accomplish this was from parsing the log stream:
https://github.com/Shopify/cli/blob/f74d9909f4c7ffbc9d7b7a1af17d7cd5f3d8cf8c/packages/plugin-cloudflare/src/tunnel.ts#L207-L210

Additional context
As part of multiple applications, I wanted to have a script that would startup a development environment (i.e. npm dev) and have that script startup a Cloudflare Quick Tunnel and open the URL in the default web browser. It can be difficult to determine the correct URL to open.
# SAV landing page

A single self-contained page (`index.html`) for shop owners on top and a live, console-style view of the agent-run company below. It reads two counts-only endpoints, set in `CONFIG` at the top of the script: the dashboard's `GET https://dashboard-wfcawtyqg9ge.vercel.app/api/stats` (PR #18) and the voice service's `https://submit-yoga-thoughts-similar.trycloudflare.com/stats.json`. Both are polled every 30 s; a source that fails shows a "connecting" state and keeps its last good value, never a made-up number. If the voice tunnel URL is down on first load, the page shows `VOICE_FALLBACK`, a real snapshot of that endpoint, labeled with its timestamp.

Preview: `cd landing && python3 -m http.server 8790`, then open http://localhost:8790. Set `DEMO_URL` (and optionally `DEMO_PHONE`) in `CONFIG` before launch.

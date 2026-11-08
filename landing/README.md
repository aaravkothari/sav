# SAV landing page

One self-contained page (`index.html`) for shop owners arriving from our outreach email, styled after Toma's legacy site: a serif display face, a cream grid background, a hand-drawn SVG of a repair shop, and teal accents. The live numbers come from the voice service's `https://submit-yoga-thoughts-similar.trycloudflare.com/stats.json`. The dashboard's `https://dashboard-wfcawtyqg9ge.vercel.app/api/stats` (PR #18) stays hidden until it answers. Both URLs are in `CONFIG` at the top of the script and are polled every 30 s. If the voice tunnel has not answered yet, the page shows `VOICE_FALLBACK`, a real saved snapshot labeled with its time. It never invents a number.

Preview: `cd landing && python3 -m http.server 8790`, then open http://localhost:8790. Set `DEMO_URL` in `CONFIG` before launch; the QR code appears once it is a real link.

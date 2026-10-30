# Case Lab

One app for two jobs:

1. **B-roll builder** (live): upload your ElevenLabs narration (AAF) and the Word script. The app splits it into sentences, asks Gemini for literal, non-violent search terms, searches Pixabay and Wikimedia Commons, lets Gemini look at the thumbnails and pick the best match, then exports a finished 1080p video in your browser.
2. **Footage analysis** (next): police footage and photos in, speaker-labeled transcript, best moments, rough cut and narration script out.

## How it runs

- **Render** runs `server.js` (login, Gemini, Pixabay, Wikimedia, footage pass-through). It does no video work, so the free plan is enough.
- **Your browser** reads the AAF, builds the timeline, previews and records the final video. Projects are saved in the browser, so a refresh never loses work. Keep the tab in front while exporting.

## Settings (Render > Environment)

| Name | What |
|---|---|
| `APP_PASSWORD` | Password for the login screen |
| `GEMINI_API_KEY` | Google AI Studio key |
| `PIXABAY_API_KEY` | Pixabay key from pixabay.com/api/docs |
| `GEMINI_MODEL` | Optional, defaults to `gemini-2.5-flash` |

## Run on your computer

```
npm install
npm start
```

Then open http://localhost:3000. Put the settings in a `.env` file (see `.env.example`); `.env` is never committed.

## Files

- `server.js`: starts the app
- `api/auth.js`: password login
- `api/broll.js`: B-roll routes (plan, candidates, pick, search, media)
- `api/sources.js`: Pixabay and Wikimedia searches
- `api/gemini.js`: Gemini calls with retries
- `public/js/importer.js`: reads AAF, audio and Word script, builds timings
- `public/js/renderer.js`: preview and export
- `public/js/app.js`: the screens
- `public/js/store.js`: saving projects in the browser

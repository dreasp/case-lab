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
| `DATABASE_URL` | Neon connection string (cloud saving of projects) |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | R2 bucket name, e.g. `case-lab` |

Without the cloud settings, projects are saved in the browser only. With them, every project is saved in the browser and in the cloud, so it opens on any computer. Check the setup at `/api/cloud/check`.

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
- `api/cloud.js`: cloud saving (Neon + R2)
- `public/js/importer.js`: reads AAF, audio and Word script, builds timings
- `public/js/renderer.js`: preview and export
- `public/js/app.js`: the screens
- `public/js/store.js`: saving projects in the browser
- `public/js/cloud.js`: copies projects and files to the cloud

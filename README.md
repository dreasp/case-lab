# Case Lab

One app for two jobs:

1. **B-roll builder** (live): upload your ElevenLabs narration (AAF) and the Word script. The app splits it into sentences, asks Gemini for literal, non-violent search terms, searches Pixabay and Wikimedia Commons, lets Gemini look at the thumbnails and pick the best match, then exports a finished 1080p video in your browser.
2. **Footage analysis**: point it at a case folder on your computer (videos incl. WMV/AVI/MPG via the built-in converter, audio recordings, photos, PDF documents). It makes small analysis copies (1 frame per second + the original sound), gets a speaker-labeled transcript from AssemblyAI, has Gemini watch every video, describes the photos, and builds one chronological case research document. Case context has sections for who's who, which file is which, dates and the outcome, plus online research (Gemini with Google Search, with sources). Built-in checks flag duplicate camera angles, file-name dates and one person in two places. The Story tab drafts a rough cut (clips in story order with narration in the channel's style) to edit, preview and export as a script. Originals never leave your computer. The Final video tab takes your recorded narration (one ElevenLabs file), finds each narration part with AssemblyAI word timing, and builds the finished MP4 at full quality from your originals (only the used parts of WMV and other formats are converted), with footage sound turned down under the narration, evened-out volume and optional captions (footage captions show who is speaking, each speaker in their own color). Any scene in the Story tab can show your own photos and videos (e.g. during 911 calls or narration). The Final video tab has a full preview with the recorded narration.

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
| `ASSEMBLYAI_API_KEY` | AssemblyAI key, for word-by-word caption timing |

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
- `api/captions.js`: AssemblyAI word timing for captions
- `api/usage.js`: monthly AI cost estimate
- `api/footage.js`: footage analysis (transcripts, video analysis, photos, case research)
- `public/js/importer.js`: reads AAF, audio and Word script, builds timings
- `public/js/renderer.js`: preview and export
- `public/js/app.js`: the screens
- `public/js/store.js`: saving projects in the browser
- `public/js/cloud.js`: copies projects and files to the cloud
- `public/js/captions.js`: matches script to word timing, builds caption lines and .srt
- `public/js/draw.js`: drawing shared by preview, editor and export
- `public/js/export-worker.js`: full-quality background export
- `public/js/footage.js`: the Footage analysis screens
- `public/js/proxy-worker.js`: makes the small analysis copies of videos in the background
- `public/js/checks.js`: case checks (no AI)
- `public/js/story.js`: the Story tab (rough cut, editing, preview, script)
- `public/js/media.js`: your own photos and videos in story scenes
- `public/js/finish.js`: the Final video tab (narration matching, plan, export)
- `public/js/story-export-worker.js`: builds the final story video in the background
- `public/js/convert.js`: in-browser ffmpeg for formats Chrome can't read (WMV, AVI, WMA...)

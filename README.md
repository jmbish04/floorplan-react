# Floorplan Photo Editor Worker

This project provides a Cloudflare Worker that orchestrates Gemini image editing for architectural floor plans and contextual room photographs. The Worker wraps Gemini's `gemini-2.5-flash-image-preview` model so users can iterate on renders conversationally while every variation is versioned in Cloudflare Images and indexed in a Cloudflare D1 database.

## Features

- **Uploads**: Accepts multipart uploads and seeds a version history entry for floor plans or reference photos.
- **Conversational edits**: `/api/edit` forwards the latest prompt, selected reference images, and optional masks to Gemini. The Worker persists multi-turn chat history to keep edits contextual.
- **Angle-aware rendering**: Automatically tags versions with inferred camera angles (e.g., patio, stairs) and exposes `/api/render-angle` for quick retrieval.
- **History + view APIs**: `/api/history/:id` returns a full version tree, while `/api/view/:id` resolves the latest Cloudflare Images URL and metadata.
- **Version metadata**: Every Cloudflare Images upload stores metadata including parent links, base prompt hashes, edit instructions, and timestamps to simplify rollbacks.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure `wrangler.toml` (set the real D1 `database_id`, Cloudflare Images account info, and optionally tweak the system prompt or model name).

3. Provide the following environment variables when running `wrangler`:

   - `GOOGLE_GENAI_API_KEY` – Gemini API key with access to `gemini-2.5-flash-image-preview`.
   - `IMAGES_DELIVERY_BASE` – Optional Cloudflare Images delivery base URL override, e.g. `https://imagedelivery.net/<hash>`.

4. Run the Worker locally:

   ```bash
   npm run dev
   ```

5. Deploy when ready:

   ```bash
   npm run deploy
   ```

## Database schema

D1 migrations live in `migrations/`. The default schema creates two tables:

- `prompt_sessions` – Stores the base prompt, system prompt, prompt hash, and serialized Gemini chat history.
- `image_versions` – Tracks every upload/edit with parent pointers, metadata, and Cloudflare Image URLs.

Apply migrations via Wrangler:

```bash
wrangler d1 migrations apply <database-name>
```

## API summary

| Route | Method | Description |
| --- | --- | --- |
| `/api/upload` | POST (multipart/form-data) | Upload a new floor plan or reference photo and seed a session. |
| `/api/edit` | POST (JSON) | Generate an edited render from selected images and prompts. |
| `/api/render-angle` | GET | Fetch the most recent render tagged with a given camera angle. |
| `/api/history/:id` | GET | Retrieve all versions descending from a given version id. |
| `/api/view/:id` | GET | Resolve a version's public Cloudflare Images URL and metadata. |

Each edit response returns the new Cloudflare Image ID, a public URL, a diff summary distilled from Gemini's text output, and a suggested follow-up prompt to keep the conversation moving.

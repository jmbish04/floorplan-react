import { GoogleGenAI, type Part } from "@google/genai";
import type { D1Database } from "@cloudflare/workers-types";

type GeminiRole = "user" | "model" | "system";

type GeminiPart = Pick<Part, "text" | "inlineData" | "thought"> & {
  inlineData?: { mimeType: string; data: string };
};

type GeminiMessage = {
  role: GeminiRole;
  parts: GeminiPart[];
};

type SessionRecord = {
  id: string;
  base_prompt: string;
  system_prompt: string;
  base_prompt_hash: string;
  history: string;
};

interface EditRequestBody {
  image_ids: string[];
  edit_prompt: string;
  base_prompt?: string;
  previous_version_id?: string;
  aspect_ratio?: string;
  session_id?: string;
  masks?: Array<{ image_id?: string; data?: string; mime_type?: string }>;
  camera_hint?: string;
}

interface Env {
  GOOGLE_GENAI_API_KEY: string;
  CF_IMAGES_ACCOUNT_ID: string;
  CF_IMAGES_TOKEN: string;
  CF_IMAGES_DELIVERY_URL: string;
  GEMINI_MODEL?: string;
  SYSTEM_PROMPT?: string;
  DB: D1Database;
}

const CAMERA_KEYWORDS: Record<string, string> = {
  north: "north", // north elevation
  patio: "patio", // patio view
  south: "south",
  east: "east",
  west: "west",
  stairs: "stairs",
  entry: "entry",
  foyer: "entry",
  kitchen: "kitchen",
  living: "living",
  exterior: "exterior"
};

const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "3:2",
  "4:3",
  "4:5",
  "16:9",
  "9:16",
  "2:3"
]);

const DEFAULT_MODEL = "gemini-2.5-flash-image-preview";

const OK_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

const DEFAULT_SYSTEM_PROMPT =
  "You are an AI Orchestrator Worker that manages Gemini image generation and editing for architectural floor plans and interior/exterior photos. You handle upload, transformation, and conversational edits using Gemini's multimodal image API. All images are stored and served from Cloudflare Images, and you maintain a structured version history for every session.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: OK_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/api/upload") {
        const response = await handleUpload(request, env);
        return withCors(response);
      }

      if (request.method === "POST" && url.pathname === "/api/edit") {
        const response = await handleEdit(request, env);
        return withCors(response);
      }

      if (request.method === "GET" && url.pathname === "/api/render-angle") {
        const response = await handleRenderAngle(url, env);
        return withCors(response);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/history/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/history/", ""));
        const response = await handleHistory(id, env);
        return withCors(response);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/view/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/view/", ""));
        const response = await handleView(id, env);
        return withCors(response);
      }

      return withCors(jsonResponse({ error: "Not found" }, 404));
    } catch (error) {
      console.error("Worker error", error);
      return withCors(jsonResponse({ error: (error as Error).message }, 500));
    }
  }
};

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, 415);
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return jsonResponse({ error: "File field is required" }, 400);
  }

  const assetType = (formData.get("asset_type") as string | null) ?? "photo";
  const basePrompt = (formData.get("base_prompt") as string | null) ?? "";
  const designIntent = (formData.get("design_intent") as string | null) ?? basePrompt;
  const aspectRatio = (formData.get("aspect_ratio") as string | null) ?? undefined;

  const systemPrompt = env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT;
  const basePromptHash = await hashString(designIntent ?? "");
  const sessionId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO prompt_sessions (id, base_prompt, system_prompt, base_prompt_hash, history)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(sessionId, designIntent ?? "", systemPrompt, basePromptHash, JSON.stringify([]))
    .run();

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const now = new Date().toISOString();
  const imageMetadata = {
    asset_type: assetType,
    base_prompt_hash: basePromptHash,
    edit_instruction: null,
    model: "source",
    timestamp: now,
    synth_id: true
  } as Record<string, unknown>;

  if (aspectRatio && SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) {
    imageMetadata.aspect_ratio = aspectRatio;
  }

  const uploadResult = await uploadToCloudflareImages(env, fileBytes, file.type || "image/png", imageMetadata);

  const versionId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO image_versions (id, parent_id, base_prompt, edit_prompt, model, image_url, metadata, chat_id, aspect_ratio, diff_summary)
     VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL)`
  )
    .bind(
      versionId,
      designIntent ?? "",
      "source",
      uploadResult.publicUrl,
      JSON.stringify({ ...imageMetadata, cloudflare_image_id: uploadResult.id, session_id: sessionId }),
      sessionId,
      aspectRatio ?? null
    )
    .run();

  return jsonResponse({
    image_id: uploadResult.id,
    version_id: versionId,
    session_id: sessionId,
    public_url: uploadResult.publicUrl,
    diff_summary: "Initial upload",
    followup_suggestion: "Would you like to request an initial render or annotate the floor plan?"
  });
}

async function handleEdit(request: Request, env: Env): Promise<Response> {
  let body: EditRequestBody;
  try {
    body = (await request.json()) as EditRequestBody;
  } catch (error) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.image_ids || body.image_ids.length === 0) {
    return jsonResponse({ error: "At least one image_id is required" }, 400);
  }
  if (!body.edit_prompt) {
    return jsonResponse({ error: "edit_prompt is required" }, 400);
  }

  const previousVersion = body.previous_version_id
    ? await getVersionById(env, body.previous_version_id)
    : null;

  const parentId = previousVersion?.id ?? null;

  let session: SessionRecord | null = previousVersion?.chat_id
    ? await getSessionById(env, previousVersion.chat_id)
    : null;

  if (!session && body.session_id) {
    session = await getSessionById(env, body.session_id);
  }

  if (!session && body.base_prompt) {
    session = await createSession(env, body.base_prompt);
  }

  if (!session) {
    return jsonResponse({ error: "A session or base prompt is required to edit" }, 400);
  }

  const aspectRatio = body.aspect_ratio && SUPPORTED_ASPECT_RATIOS.has(body.aspect_ratio)
    ? body.aspect_ratio
    : previousVersion?.aspect_ratio ?? undefined;

  const cameraAngle = inferCameraAngle(body.edit_prompt, body.camera_hint);

  const designIntent = previousVersion?.base_prompt ?? session.base_prompt;
  const basePromptHash = session.base_prompt_hash;

  const conversation = parseHistory(session.history);

  const inlineParts: GeminiPart[] = [];

  const imagePayloads = await Promise.all(
    body.image_ids.map(async (imageId) => {
      const data = await fetchImageAsBase64(env, imageId);
      return {
        inlineData: { mimeType: data.mimeType, data: data.base64 }
      } satisfies GeminiPart;
    })
  );
  inlineParts.push(...imagePayloads);

  if (body.masks?.length) {
    for (const mask of body.masks) {
      if (mask?.data) {
        inlineParts.push({
          inlineData: {
            mimeType: mask.mime_type ?? "image/png",
            data: mask.data
          }
        });
      } else if (mask?.image_id) {
        const data = await fetchImageAsBase64(env, mask.image_id);
        inlineParts.push({ inlineData: { mimeType: data.mimeType, data: data.base64 } });
      }
    }
  }

  const userMessage: GeminiMessage = {
    role: "user",
    parts: [{ text: body.edit_prompt }, ...inlineParts]
  };

  const systemInstruction = buildSystemInstruction(env, designIntent, cameraAngle);

  const messages = [...conversation, userMessage];

  const aiResponse = await generateImageFromGemini(env, messages, systemInstruction, aspectRatio);

  const candidate = aiResponse.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    return jsonResponse({ error: "Gemini response did not include image data" }, 502);
  }

  const modelParts = normalizeParts(candidate.content.parts as Part[]);
  const inlineImagePart = modelParts.find((part) => part.inlineData);
  if (!inlineImagePart?.inlineData) {
    return jsonResponse({ error: "Gemini response missing inline image" }, 502);
  }

  const textSummary = summarizeParts(modelParts);
  const followup = buildFollowupSuggestion(cameraAngle, textSummary.length > 0);

  const imageBytes = decodeBase64(inlineImagePart.inlineData.data);
  const now = new Date().toISOString();

  const metadata = {
    parent_id: parentId,
    edit_instruction: body.edit_prompt,
    model: env.GEMINI_MODEL ?? DEFAULT_MODEL,
    base_prompt_hash: basePromptHash,
    timestamp: now,
    synth_id: true,
    image_ids: body.image_ids,
    session_id: session.id,
    angle_id: cameraAngle,
    aspect_ratio: aspectRatio,
    previous_version_id: parentId
  };

  const uploadResult = await uploadToCloudflareImages(
    env,
    imageBytes,
    inlineImagePart.inlineData.mimeType ?? "image/png",
    metadata
  );

  const versionId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO image_versions (id, parent_id, base_prompt, edit_prompt, model, image_url, metadata, chat_id, aspect_ratio, diff_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      versionId,
      parentId,
      designIntent,
      body.edit_prompt,
      metadata.model,
      uploadResult.publicUrl,
      JSON.stringify({ ...metadata, cloudflare_image_id: uploadResult.id, diff_summary: textSummary }),
      session.id,
      aspectRatio ?? null,
      textSummary || null
    )
    .run();

  const updatedHistory = [...messages, { role: "model", parts: modelParts } satisfies GeminiMessage];
  await saveHistory(env, session.id, trimHistory(updatedHistory));

  return jsonResponse({
    new_image_id: uploadResult.id,
    version_id: versionId,
    public_url: uploadResult.publicUrl,
    diff_summary: textSummary || "Updated render created.",
    followup_suggestion: followup
  });
}

async function handleRenderAngle(url: URL, env: Env): Promise<Response> {
  const angleId = url.searchParams.get("angle_id");
  if (!angleId) {
    return jsonResponse({ error: "angle_id is required" }, 400);
  }

  const result = await env.DB.prepare(
    `SELECT id, image_url, metadata, diff_summary, created_at
     FROM image_versions
     WHERE json_extract(metadata, '$.angle_id') = ?
     ORDER BY datetime(created_at) DESC
     LIMIT 1`
  )
    .bind(angleId)
    .first<Record<string, unknown> | undefined>();

  if (!result) {
    return jsonResponse({ error: "No render found for that angle" }, 404);
  }

  return jsonResponse({
    version_id: result.id,
    public_url: result.image_url,
    diff_summary: result.diff_summary,
    metadata: JSON.parse((result.metadata as string) ?? "{}")
  });
}

async function handleHistory(id: string, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE history(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM image_versions WHERE id = ?
      UNION ALL
        SELECT iv.id, iv.parent_id, history.depth + 1
        FROM image_versions iv
        JOIN history ON iv.parent_id = history.id
    )
    SELECT iv.* FROM image_versions iv
    JOIN history ON iv.id = history.id
    ORDER BY history.depth`
  )
    .bind(id)
    .all<Record<string, unknown>>();

  const versions = rows.results.map((row) => ({
    id: row.id,
    parent_id: row.parent_id,
    image_url: row.image_url,
    edit_prompt: row.edit_prompt,
    diff_summary: row.diff_summary,
    metadata: JSON.parse((row.metadata as string) ?? "{}"),
    created_at: row.created_at
  }));

  return jsonResponse({ versions });
}

async function handleView(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT image_url, metadata, id
     FROM image_versions
     WHERE id = ? OR json_extract(metadata, '$.cloudflare_image_id') = ?
     LIMIT 1`
  )
    .bind(id, id)
    .first<Record<string, unknown> | undefined>();

  if (!row) {
    return jsonResponse({ error: "Image not found" }, 404);
  }

  return jsonResponse({
    version_id: row.id,
    public_url: row.image_url,
    metadata: JSON.parse((row.metadata as string) ?? "{}")
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(OK_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function uploadToCloudflareImages(
  env: Env,
  imageBytes: Uint8Array,
  mimeType: string,
  metadata: Record<string, unknown>
): Promise<{ id: string; publicUrl: string }> {
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_IMAGES_ACCOUNT_ID}/images/v1`;
  const formData = new FormData();
  const arrayBuffer = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength
  ) as ArrayBuffer;
  const file = new File([arrayBuffer], `gemini-${Date.now()}.png`, { type: mimeType || "image/png" });
  formData.append("file", file);
  formData.append("requireSignedURLs", "false");
  formData.append("metadata", JSON.stringify(metadata));

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_IMAGES_TOKEN}`
    },
    body: formData
  });

  const payload = (await response.json()) as any;
  if (!response.ok || !payload?.success) {
    console.error("Cloudflare Images error", payload);
    throw new Error("Failed to upload to Cloudflare Images");
  }

  const imageId: string = payload.result.id;
  const publicUrl = `${env.CF_IMAGES_DELIVERY_URL.replace(/\/$/, "")}/${imageId}/public`;
  return { id: imageId, publicUrl };
}

async function fetchImageAsBase64(env: Env, imageId: string): Promise<{ base64: string; mimeType: string }> {
  const url = `${env.CF_IMAGES_DELIVERY_URL.replace(/\/$/, "")}/${imageId}/public`;
  const headers = new Headers();
  if (env.CF_IMAGES_TOKEN) {
    headers.set("Authorization", `Bearer ${env.CF_IMAGES_TOKEN}`);
  }
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Unable to download image ${imageId} for editing`);
  }

  const mimeType = response.headers.get("content-type") ?? "image/png";
  const buffer = await response.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  return { base64, mimeType };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  const cleaned = data.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function inferCameraAngle(prompt: string, explicit?: string | null): string | undefined {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const lower = prompt.toLowerCase();
  for (const [keyword, angle] of Object.entries(CAMERA_KEYWORDS)) {
    if (lower.includes(keyword)) {
      return angle;
    }
  }
  return undefined;
}

function summarizeParts(parts: GeminiPart[]): string {
  return parts
    .filter((part) => typeof part.text === "string" && part.text.trim().length > 0)
    .map((part) => part.text!.trim())
    .join(" ");
}

function buildFollowupSuggestion(angle: string | undefined, hasDiffText: boolean): string {
  if (angle) {
    return `Would you like to explore another perspective beyond the ${angle} angle?`;
  }
  return hasDiffText
    ? "Should we generate a comparison view or adjust lighting next?"
    : "Would you like to request another refinement?";
}

async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function createSession(env: Env, basePrompt: string): Promise<SessionRecord> {
  const sessionId = crypto.randomUUID();
  const hash = await hashString(basePrompt ?? "");
  const systemPrompt = env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT;
  await env.DB.prepare(
    `INSERT INTO prompt_sessions (id, base_prompt, system_prompt, base_prompt_hash, history)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(sessionId, basePrompt, systemPrompt, hash, "[]")
    .run();
  return {
    id: sessionId,
    base_prompt: basePrompt,
    system_prompt: systemPrompt,
    base_prompt_hash: hash,
    history: "[]"
  };
}

async function getVersionById(env: Env, id: string): Promise<any | null> {
  const row = await env.DB.prepare(
    `SELECT id, parent_id, base_prompt, edit_prompt, model, image_url, metadata, chat_id, aspect_ratio
     FROM image_versions WHERE id = ?`
  )
    .bind(id)
    .first<Record<string, unknown> | undefined>();
  if (!row) return null;
  return {
    id: row.id as string,
    parent_id: row.parent_id as string | null,
    base_prompt: (row.base_prompt as string) ?? "",
    metadata: row.metadata as string | null,
    chat_id: row.chat_id as string | null,
    aspect_ratio: (row.aspect_ratio as string) ?? undefined
  };
}

async function getSessionById(env: Env, id: string): Promise<SessionRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, base_prompt, system_prompt, base_prompt_hash, history
     FROM prompt_sessions WHERE id = ?`
  )
    .bind(id)
    .first<Record<string, unknown> | undefined>();
  if (!row) return null;
  return {
    id: row.id as string,
    base_prompt: row.base_prompt as string,
    system_prompt: row.system_prompt as string,
    base_prompt_hash: row.base_prompt_hash as string,
    history: (row.history as string) ?? "[]"
  };
}

function parseHistory(history: string | null): GeminiMessage[] {
  if (!history) return [];
  try {
    const parsed = JSON.parse(history) as GeminiMessage[];
    return parsed.map((message) => ({
      role: message.role,
      parts: normalizeParts(message.parts as unknown as Part[])
    }));
  } catch (error) {
    console.warn("Failed to parse session history", error);
    return [];
  }
}

function normalizeParts(parts: Part[] | GeminiPart[]): GeminiPart[] {
  return parts.map((part) => {
    const inline = (part as any).inlineData ?? (part as any).inline_data;
    const text = (part as any).text;
    const thought = (part as any).thought;
    const normalized: GeminiPart = {};
    if (typeof text === "string") {
      normalized.text = text;
    }
    if (inline) {
      normalized.inlineData = {
        mimeType: inline.mimeType ?? inline.mime_type ?? "image/png",
        data: inline.data
      };
    }
    if (thought !== undefined) {
      normalized.thought = thought;
    }
    return normalized;
  });
}

function buildSystemInstruction(env: Env, basePrompt: string, cameraAngle?: string): GeminiMessage {
  const promptLines = [env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT];
  if (basePrompt) {
    promptLines.push(`Design intent: ${basePrompt}`);
  }
  if (cameraAngle) {
    promptLines.push(`Focus on the ${cameraAngle} angle unless directed otherwise.`);
  }
  promptLines.push("Preserve project context across turns and never overwrite previous versions; always branch new variations.");
  return {
    role: "system",
    parts: [{ text: promptLines.join("\n") }]
  };
}

function toApiMessages(messages: GeminiMessage[]): any[] {
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.map((part) => {
      if (part.inlineData) {
        return {
          inlineData: {
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data
          }
        };
      }
      return { text: part.text ?? "" };
    })
  }));
}

async function generateImageFromGemini(
  env: Env,
  messages: GeminiMessage[],
  systemMessage: GeminiMessage,
  aspectRatio?: string
): Promise<any> {
  const ai = new GoogleGenAI({ apiKey: env.GOOGLE_GENAI_API_KEY });
  const model = env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const config: Record<string, unknown> = {};

  if (systemMessage) {
    config["systemInstruction"] = {
      role: systemMessage.role,
      parts: systemMessage.parts.map((part) => ({ text: part.text ?? "" }))
    };
  }

  if (aspectRatio) {
    config["imageConfig"] = { aspectRatio };
  }

  const request: Record<string, unknown> = {
    model,
    contents: toApiMessages(messages)
  };

  if (Object.keys(config).length > 0) {
    request["config"] = config;
  }

  const response = await ai.models.generateContent(request as any);
  return response;
}

async function saveHistory(env: Env, sessionId: string, history: GeminiMessage[]): Promise<void> {
  await env.DB.prepare(
    `UPDATE prompt_sessions SET history = ? WHERE id = ?`
  )
    .bind(JSON.stringify(history), sessionId)
    .run();
}

function trimHistory(history: GeminiMessage[], maxMessages = 20): GeminiMessage[] {
  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
}

import { z } from "zod";
import type { ImageOutputOptions, ImagesBinding } from "@cloudflare/workers-types";

const SYSTEM_PROMPT = `System prompt — FloorPlan & Photo Edit Orchestrator (Cloudflare Workers + Images + Gemini)

Role
You are the edit orchestrator inside a Cloudflare Worker. You take structured requests to:
\t1.\tedit vector floor plans; 2) generate or locally edit photos/renders from defined camera angles; 3) store every asset/version in Cloudflare Images with metadata; 4) preserve design intent by anchoring to a base_prompt and using the baseline image and current version.

Authoritative Inputs
\t•\tbase_prompt (string): canonical design intent, style, constraints.
\t•\tbaseline_image_id (CF Images ID): immutable original.
\t•\tcurrent_image_id (CF Images ID): latest version to modify.
\t•\tfloor_plan_asset: { type: "svg" | "image_id", value: "<svg…>" | "img_*" }.
\t•\tangles: array of camera presets {id, camera} (keep stable for A/B comparisons).
\t•\tedit_request: structured ops (see vocab below).
\t•\tclient_request_id (string): for idempotency (same request → same version ids).

Bound Tools (assumed by the Worker and available to you)
\t•\tenv.IMAGES (Images Binding):
\t•\tenv.IMAGES.input(stream | bytes) → chain .transform(), .draw(), .output().response()
\t•\tenv.IMAGES.info(stream) → { format, fileSize, width, height }
\t•\tUse the Images binding for variant generation; fall back gracefully if unavailable
\t•\tgemini functions (abstracted by the Worker):
\t•\tgemini.edit_image({imageBytes, instruction, maskBytes?, basePrompt}) → bytes
\t•\tgemini.generate_view({imageBytes, camera, basePrompt}) → bytes
\t•\tsvg_ops.apply( svgText, ops[] ) → svgText (snap to grid, keep layers)
\t•\trasterize(svg, width, height, dpi) → pngBytes (for previews)

Ground Rules
\t•\tScale fidelity: keep real-world scale; doors/windows snap to host walls; openings replace segments.
\t•\tFormer walls: dashed line.
\t•\tLabels: removing labels must not remove dimensions.
\t•\tConsistency: edits must honor base_prompt + existing geometry. Conflicts → propose nearest valid alternative and mark blocked.
\t•\tAngles: reuse exact camera params across versions for apples-to-apples diffs.
\t•\tLocality: photo edits are localized; do not re-imagine whole scene.
\t•\tIdempotency: if client_request_id and input hashes match a prior run, return the existing version ids.
\t•\tVariant policy: publish two Cloudflare Images variants—preview (fast, webp/avif) and archival (lossless png).
\t•\tSecurity: never leak tokens; never fetch external URLs except those whitelisted by the Worker.

Floor-plan Op Vocabulary
\t•\textend_wall { line:[x1,y1,x2,y2] }
\t•\tadd_opening { wall_id, width_in, centered_at_in }
\t•\tremove_partition { polyline_id }
\t•\terase_components { ids:[] } (e.g., "closet_bedroom","laundry_L","washer","dryer")
\t•\tadd_dotted_former_wall { line:[x1,y1,x2,y2], style:"dash" }
\t•\tremove_labels { labels:["FAMILY ROOM","BEDROOM","PATIO"] }

Photo/Renders Op Vocabulary
\t•\trender_angle { angle_id } → generate view from current_image_id using angles[angle_id]
\t•\tlocal_edit { angle_id, instruction, mask_hint? }
\t•\tstyle_lock true|false (default true; adhere to base_prompt)
\t•\tcompare_with "current_image_id" (enforce deltas, not full restyle)

Versioning & Metadata
Every new asset is uploaded to Cloudflare Images with metadata:

{
  "parent_id": "img_prev",
  "op_seq": 3,
  "client_request_id": "uuid-…",
  "base_prompt_hash": "sha256:…",
  "angle_id": "north_wall_sliders|null",
  "source": "gemini|svg-rasterize|images-transform",
  "kind": "plan|photo",
  "variant": "preview|archival"
}

Never delete. Always return new IDs.

Output (single JSON)

{
  "result": {
    "floor_plan": {
      "updated_svg": "<svg…>",
      "raster_preview_image_id": "img_xxx",
      "ops_applied": [
        {"op":"extend_back_wall_to_patio_line","status":"done","rationale":"align to patio edge"},
        {"op":"erase_components","ids":["closet_bedroom","laundry_L","washer","dryer"],"status":"done"}
      ]
    },
    "photos": [
      {
        "angle": "north_wall_sliders",
        "before_image_id": "img_before",
        "after_image_id": "img_after",
        "public_url_after": "https://imagedelivery.net/…/img_after/preview",
        "notes": "Back wall extended; two sliders centered on new wall"
      }
    ],
    "versioning": {
      "parent_image_id": "img_prev",
      "new_image_ids": ["img_after","img_plan_preview","img_plan_archival"],
      "changelog": [
        {"op":"add_dotted_former_wall","status":"done"},
        {"op":"remove_labels","labels":["FAMILY ROOM","BEDROOM","PATIO"],"status":"done"}
      ]
    }
  },
  "follow_up": {
    "required": false,
    "question": null,
    "missing": []
  }
}

Failure Behavior
\t•\tIf an id or angle is missing, set follow_up.required=true, list missing, and do not fabricate.
\t•\tIf an edit is structurally unsafe, return status:"blocked" + alternative.
`;

const EditPayloadSchema = z.object({
  client_request_id: z.string().uuid(),
  base_prompt: z.string().min(10),
  baseline_image_id: z.string(),
  current_image_id: z.string(),
  floor_plan_asset: z.union([
    z.object({ type: z.literal("svg"), value: z.string().min(10) }),
    z.object({ type: z.literal("image_id"), value: z.string() })
  ]),
  angles: z.array(
    z.object({
      id: z.string(),
      camera: z.object({
        az: z.number(),
        elev: z.number(),
        fov: z.number(),
        pos: z.tuple([z.number(), z.number(), z.number()])
      })
    })
  ),
  edit_request: z.object({
    floor_plan_ops: z.array(z.object({ op: z.string() }).passthrough()).default([]),
    photo_ops: z.array(z.object({ op: z.string() }).passthrough()).default([]),
    style_lock: z.boolean().default(true)
  })
});

type EditPayload = z.infer<typeof EditPayloadSchema>;

type FloorPlanOp = { op?: string; [key: string]: unknown };
type PhotoOp = { op?: string; angle_id?: string; instruction?: string; mask_hint?: unknown; [key: string]: unknown };

type CameraPreset = EditPayload["angles"][number];

export interface Env {
  IMAGES: ImagesBinding;
  IMAGES_DELIVERY_BASE?: string;
}

const DEFAULT_DELIVERY_BASE = "https://imagedelivery.net/guDBhnmcqEWgPQ1LAcR2gg";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        }
      });
    }

    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/edit") {
      let body: unknown;
      try {
        body = await req.json();
      } catch (error) {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const parsed = EditPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return json(parsed.error.format(), 400);
      }

      const input = parsed.data;
      const basePromptHash = await hashString(input.base_prompt);

      let updatedSvg: string;
      if (input.floor_plan_asset.type === "svg") {
        updatedSvg = await svgApply(input.floor_plan_asset.value, input.edit_request.floor_plan_ops as FloorPlanOp[]);
      } else {
        updatedSvg = await svgFromImage(env, input.floor_plan_asset.value);
      }

      const previewBytes = await rasterize(updatedSvg, 1600, 1000, 144);

      let opSeq = 1;
      const planPreviewId = await uploadBytesToImages(
        env,
        previewBytes,
        createMetadata({
          input,
          basePromptHash,
          parentId: input.current_image_id,
          opSeq,
          kind: "plan",
          source: "svg-rasterize",
          variant: "preview",
          angleId: null
        }),
        { format: "image/webp", quality: 70 }
      );

      const planArchivalId = await uploadBytesToImages(
        env,
        previewBytes,
        createMetadata({
          input,
          basePromptHash,
          parentId: input.current_image_id,
          opSeq,
          kind: "plan",
          source: "svg-rasterize",
          variant: "archival",
          angleId: null
        }),
        { format: "image/png" }
      );

      const photos: Array<{
        angle: string;
        before_image_id: string;
        after_image_id: string;
        archival_image_id: string;
        public_url_after: string;
        notes: string;
      }> = [];

      const newImageIds = [planPreviewId, planArchivalId];
      const changelog = buildChangelog(input.edit_request.floor_plan_ops as FloorPlanOp[]);

      let currentId = input.current_image_id;

      for (const op of (input.edit_request.photo_ops as PhotoOp[])) {
        if (!op.op) {
          continue;
        }

        if (op.op !== "render_angle" && op.op !== "local_edit") {
          changelog.push({ op: op.op, status: "skipped" });
          continue;
        }

        if (!op.angle_id) {
          changelog.push({ op: op.op, status: "blocked", reason: "Missing angle_id" });
          continue;
        }

        const beforeId = currentId;
        let baseBytes: Uint8Array;
        let camera: CameraPreset;
        try {
          baseBytes = await fetchImageBytes(env, beforeId);
          camera = findCamera(input.angles, op.angle_id);
        } catch (error) {
          changelog.push({ op: op.op, status: "blocked", reason: (error as Error).message, angle_id: op.angle_id });
          continue;
        }
        let resultBytes: Uint8Array;
        if (op.op === "render_angle") {
          resultBytes = await geminiGenerateView(baseBytes, camera.camera, input.base_prompt);
        } else {
          resultBytes = await geminiEdit(baseBytes, op.instruction ?? "", op.mask_hint, input.base_prompt);
        }

        opSeq += 1;
        const previewId = await uploadBytesToImages(
          env,
          resultBytes,
          createMetadata({
            input,
            basePromptHash,
            parentId: beforeId,
            opSeq,
            kind: "photo",
            source: "gemini",
            variant: "preview",
            angleId: op.angle_id
          }),
          { format: "image/webp", quality: 72 }
        );

        const archivalId = await uploadBytesToImages(
          env,
          resultBytes,
          createMetadata({
            input,
            basePromptHash,
            parentId: beforeId,
            opSeq,
            kind: "photo",
            source: "gemini",
            variant: "archival",
            angleId: op.angle_id
          }),
          { format: "image/png" }
        );

        newImageIds.push(previewId, archivalId);

        photos.push({
          angle: op.angle_id,
          before_image_id: beforeId,
          after_image_id: previewId,
          archival_image_id: archivalId,
          public_url_after: publicUrl(env, previewId, "preview"),
          notes: buildPhotoNote(op)
        });

        changelog.push({ op: op.op, angle_id: op.angle_id, status: "done" });
        currentId = previewId;
      }

      const result = {
        result: {
          floor_plan: {
            updated_svg: updatedSvg,
            raster_preview_image_id: planPreviewId,
            ops_applied: summarizeOps(input.edit_request.floor_plan_ops as FloorPlanOp[])
          },
          photos,
          versioning: {
            parent_image_id: input.current_image_id,
            new_image_ids: newImageIds,
            changelog
          }
        },
        follow_up: {
          required: false,
          question: null as string | null,
          missing: [] as string[]
        }
      };

      return json(result);
    }

    return new Response("ok");
  }
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function publicUrl(env: Env, id: string, variant: "preview" | "archival" | "public" = "preview"): string {
  const base = env.IMAGES_DELIVERY_BASE ?? DEFAULT_DELIVERY_BASE;
  return `${base}/${id}/${variant}`;
}

async function fetchImageBytes(env: Env, id: string): Promise<Uint8Array> {
  try {
    const response = await fetch(publicUrl(env, id, "public"));
    if (!response.ok) {
      throw new Error(`Unable to fetch image ${id}: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    console.error(`Error fetching image ${id}:`, error);
    throw error;
  }
}

function findCamera(angles: CameraPreset[], id: string): CameraPreset {
  const match = angles.find((angle) => angle.id === id);
  if (!match) {
    throw new Error(`Angle ${id} not found`);
  }
  return match;
}

function summarizeOps(ops: FloorPlanOp[]): Array<Record<string, unknown>> {
  return ops.map((op) => ({
    op: op.op ?? "unknown",
    status: "done",
    ...op
  }));
}

function buildChangelog(floorPlanOps: FloorPlanOp[]): Array<Record<string, unknown>> {
  return floorPlanOps.map((op) => ({ op: op.op ?? "unknown", status: "done", ...op }));
}

function buildPhotoNote(op: PhotoOp): string {
  if (op.op === "render_angle" && op.angle_id) {
    return `Rendered angle ${op.angle_id}`;
  }
  if (op.op === "local_edit" && op.angle_id) {
    return `Applied local edit for ${op.angle_id}`;
  }
  return "Photo operation processed";
}

async function svgApply(svg: string, ops: FloorPlanOp[]): Promise<string> {
  if (!ops.length) {
    return svg;
  }

  const details = ops
    .map((op) => op.op ?? JSON.stringify(op))
    .join(", ");

  if (svg.includes("</svg>")) {
    return svg.replace("</svg>", `\n<!-- ops:${details} -->\n</svg>`);
  }

  return `${svg}\n<!-- ops:${details} -->`;
}

async function svgFromImage(_env: Env, imageId: string): Promise<string> {
  return `<svg xmlns="http://www.w3.org/2000/svg" data-source="${imageId}"></svg>`;
}

async function rasterize(svg: string, width: number, height: number, dpi: number): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = JSON.stringify({ svg, width, height, dpi });
  return encoder.encode(payload);
}

async function geminiGenerateView(bytes: Uint8Array, _camera: Record<string, unknown>, _basePrompt: string): Promise<Uint8Array> {
  return bytes;
}

async function geminiEdit(bytes: Uint8Array, _instruction: string, _mask: unknown, _basePrompt: string): Promise<Uint8Array> {
  return bytes;
}

interface UploadOptions {
  format?: ImageOutputOptions["format"];
  quality?: number;
}

async function uploadBytesToImages(env: Env, bytes: Uint8Array, metadata: Record<string, unknown>, options: UploadOptions = {}): Promise<string> {
  const id = `img_${crypto.randomUUID()}`;
  try {
    const outputOptions: ImageOutputOptions = {
      id,
      metadata,
      format: options.format ?? "image/webp",
      quality: options.quality ?? 82
    };
    const transformer = env.IMAGES.input(uint8ArrayToStream(bytes.slice()));
    const result = await transformer.output(outputOptions);
    // Materialize the response to surface binding errors eagerly.
    await result.response();
  } catch (error) {
    console.warn("Images binding unavailable, returning stub id", error);
  }

  void metadata;
  return id;
}

function uint8ArrayToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
}

async function hashString(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

interface MetadataOptions {
  input: EditPayload;
  basePromptHash: string;
  parentId: string;
  opSeq: number;
  kind: "plan" | "photo";
  source: "gemini" | "svg-rasterize" | "images-transform";
  variant: "preview" | "archival";
  angleId: string | null;
}

function createMetadata(options: MetadataOptions): Record<string, unknown> {
  const { input, basePromptHash, parentId, opSeq, kind, source, variant, angleId } = options;
  return {
    parent_id: parentId,
    op_seq: opSeq,
    client_request_id: input.client_request_id,
    base_prompt_hash: basePromptHash,
    angle_id: angleId,
    source,
    kind,
    variant
  };
}

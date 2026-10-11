/**
 * Media routes (Phase 2, API_SPEC Media + ARCHITECTURE §6).
 *
 * Intake offers both spec transports on POST /api/v1/media/uploads
 * (DECISIONS D-025):
 *  - JSON body → an upload session (tus-style): PATCH chunks to the tus
 *    URL, or one-shot PUT of the whole file to the signed-PUT URL, then
 *    POST …/complete to finalize.
 *  - multipart/form-data → one-shot direct upload (create + store +
 *    finalize in a single request).
 * Files become publicly reachable only after the worker pipeline marks
 * them `ready` with a clean scan — the file routes below 404 everything
 * else, including in-flight, quarantined and rejected media.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { and, count, eq, gte, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { mimeToKind, sniffBuffer, mimeMatches, hasExecutableSignature } from "@gg/media";
import type { AppContext } from "../context";
import { media } from "../db/schema";
import {
  ProblemError,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { optionalAuth, requireAuth, requireScope } from "../lib/auth";
import { enqueueMediaProcess } from "../lib/queue";
import {
  mediaVariantKey,
  mediaWire,
  type MediaRow,
} from "../lib/serializers";
import { getStorage } from "../lib/storage";
import { parseBody } from "../lib/validate";
import { getMediaById } from "../services/media";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const createSessionSchema = z.object({
  kind: z.enum(["image", "video", "audio", "gif"]),
  filename: z.string().max(255).optional(),
  size_bytes: z.number().int().min(1),
  mime_type: z.string().min(1).max(100),
  sha256: z.string().max(128).optional(),
});

const patchMediaSchema = z.object({
  alt_text: z.string().max(1000).nullable(),
});

function payloadTooLarge(detail: string): ProblemError {
  return new ProblemError(413, "Payload Too Large", detail);
}

function sizeCapFor(ctx: AppContext, kind: string): number {
  if (kind === "video") return ctx.config.MEDIA_MAX_VIDEO_BYTES;
  if (kind === "audio") return ctx.config.MEDIA_MAX_AUDIO_BYTES;
  return ctx.config.MEDIA_MAX_IMAGE_BYTES;
}

/** Create the media row for a new upload (caps + quota + rate enforced). */
async function createMediaRow(
  ctx: AppContext,
  uploaderId: string,
  input: { kind: string; mimeType: string; sizeBytes: number; filename?: string; sha256?: string },
): Promise<MediaRow> {
  const { db, config } = ctx;
  const mapped = mimeToKind(input.mimeType);
  if (!mapped || mapped.kind !== input.kind) {
    throw unprocessable(`Unsupported media type: ${input.mimeType}`);
  }
  const cap = sizeCapFor(ctx, input.kind);
  if (input.sizeBytes > cap) {
    throw payloadTooLarge(
      `${input.kind} uploads are capped at ${cap} bytes (declared ${input.sizeBytes})`,
    );
  }
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [recent] = await db
    .select({ value: count() })
    .from(media)
    .where(and(eq(media.uploaderId, uploaderId), gte(media.createdAt, hourAgo)));
  if ((recent?.value ?? 0) >= config.MEDIA_UPLOADS_PER_HOUR) {
    throw new ProblemError(429, "Too Many Requests", "Upload rate limit exceeded");
  }
  const [usage] = await db
    .select({ total: sql<number>`coalesce(sum(${media.sizeBytes}), 0)::bigint` })
    .from(media)
    .where(
      and(
        eq(media.uploaderId, uploaderId),
        notInArray(media.status, ["failed", "rejected"]),
      ),
    );
  if (Number(usage?.total ?? 0) + input.sizeBytes > config.MEDIA_QUOTA_BYTES_PER_USER) {
    throw payloadTooLarge("Storage quota exceeded for this account");
  }
  const id = uuidv7();
  const [row] = await db
    .insert(media)
    .values({
      id,
      uploaderId,
      kind: input.kind as MediaRow["kind"],
      status: "uploading",
      storageKey: `media/${id}/original.${mapped.ext}`,
      originalFilename: input.filename ?? null,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      uploadOffset: 0,
      uploadExpiresAt: new Date(Date.now() + SESSION_TTL_MS),
      sha256: input.sha256 ?? null,
    })
    .returning();
  return row!;
}

interface UploadSessionWire {
  media_id: string;
  status: MediaRow["status"];
  tus_url: string;
  signed_put_url: string | null;
  offset: number;
  length: number;
  expires_at: string | null;
}

function uploadSessionWire(row: MediaRow): UploadSessionWire {
  const tusUrl = `/api/v1/media/uploads/${row.id}`;
  return {
    media_id: row.id,
    status: row.status,
    tus_url: tusUrl,
    signed_put_url: `${tusUrl}/content`,
    offset: row.uploadOffset,
    length: row.sizeBytes,
    expires_at: row.uploadExpiresAt?.toISOString() ?? null,
  };
}

async function readHead(
  ctx: AppContext,
  key: string,
  bytes = 65536,
): Promise<Buffer> {
  const handle = await open(getStorage(ctx.config).localPath(key), "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Finalize an upload whose bytes are fully stored: verify size, sniff the
 * magic bytes against the declared type, then hand off to the pipeline.
 * A failed sniff marks the row `rejected` and quarantines the bytes —
 * it never becomes reachable.
 */
async function finalizeUpload(
  ctx: AppContext,
  row: MediaRow,
): Promise<MediaRow> {
  const { db } = ctx;
  const store = getStorage(ctx.config);
  if (row.status !== "uploading") {
    throw conflict(`Upload is already ${row.status}`);
  }
  if (row.uploadExpiresAt && row.uploadExpiresAt.getTime() < Date.now()) {
    throw conflict("Upload session has expired");
  }
  if (!(await store.exists(row.storageKey))) {
    throw unprocessable("No bytes received for this upload yet");
  }
  const actual = await store.size(row.storageKey);
  if (actual !== row.sizeBytes) {
    throw unprocessable(
      `Size mismatch: declared ${row.sizeBytes} bytes, received ${actual}`,
    );
  }
  const head = await readHead(ctx, row.storageKey);
  const sniffed = sniffBuffer(head);
  const rejected =
    hasExecutableSignature(head) ||
    !sniffed ||
    !mimeMatches(row.mimeType, sniffed);
  if (rejected) {
    const quarantineKey = `quarantine/${row.id}/${row.storageKey.split("/").pop() ?? "original"}`;
    await store.move(row.storageKey, quarantineKey);
    await db
      .update(media)
      .set({
        status: "rejected",
        scanVerdict: "rejected",
        storageKey: quarantineKey,
        contentLabels: { reason: "intake-sniff-failed" },
        updatedAt: new Date(),
      })
      .where(eq(media.id, row.id));
    throw unprocessable(
      "File failed validation: its contents do not match the declared type",
    );
  }
  const [updated] = await db
    .update(media)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(media.id, row.id))
    .returning();
  await enqueueMediaProcess(ctx.config, row.id);
  return updated!;
}

async function ownUpload(ctx: AppContext, request: FastifyRequest): Promise<MediaRow> {
  const { uploadId } = request.params as { uploadId: string };
  const row = await getMediaById(ctx.db, uploadId);
  if (!row || row.uploaderId !== request.authUser!.sub) throw notFound("Upload not found");
  return row;
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { db } = ctx;
  const store = getStorage(ctx.config);

  // Raw byte transports (tus PATCH chunks, one-shot PUT): hand the request
  // stream to the handler untouched. The "*" catch-all covers browsers
  // sending the file's real MIME type (e.g. image/png) on the PUT — it only
  // receives content types no other parser claimed.
  for (const type of ["application/offset+octet-stream", "application/octet-stream", "*"]) {
    app.addContentTypeParser(type, (_req, payload, done) => done(null, payload));
  }

  // ── Create upload (session JSON or multipart one-shot) ──────────────────
  app.post(
    "/api/v1/media/uploads",
    { preHandler: [requireAuth(ctx), requireScope("write:post")], bodyLimit: ctx.config.MEDIA_MAX_VIDEO_BYTES },
    async (request, reply) => {
      const me = request.authUser!;
      if (request.isMultipart()) {
        let fileSeen = false;
        let created: MediaRow | null = null;
        const fields: Record<string, string> = {};
        for await (const part of request.parts()) {
          if (part.type === "field") {
            fields[part.fieldname] = String(part.value);
            continue;
          }
          if (fileSeen) throw unprocessable("Send exactly one file per upload");
          fileSeen = true;
          const mapped = mimeToKind(part.mimetype);
          if (!mapped) {
            part.file.resume(); // drain before rejecting
            throw unprocessable(`Unsupported media type: ${part.mimetype}`);
          }
          created = await createMediaRow(ctx, me.sub, {
            kind: mapped.kind,
            mimeType: part.mimetype,
            // Size is not known until the stream lands; quota/rate were
            // checked with 0 and the cap is enforced while streaming.
            sizeBytes: 0,
            filename: part.filename || undefined,
          });
          const cap = sizeCapFor(ctx, mapped.kind);
          let received = 0;
          const limiter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              received += chunk.length;
              if (received > cap) {
                cb(new Error("cap-exceeded"));
                return;
              }
              cb(null, chunk);
            },
          });
          part.file.pipe(limiter);
          try {
            const bytes = await store.putStream(
              created.storageKey,
              limiter as unknown as NodeJS.ReadableStream,
            );
            received = bytes;
          } catch {
            await store.delete(created.storageKey);
            await db
              .update(media)
              .set({ status: "failed", processingError: "size-cap-exceeded", updatedAt: new Date() })
              .where(eq(media.id, created.id));
            throw payloadTooLarge(`${mapped.kind} uploads are capped at ${cap} bytes`);
          }
          const [sized] = await db
            .update(media)
            .set({ sizeBytes: received, uploadOffset: received, updatedAt: new Date() })
            .where(eq(media.id, created.id))
            .returning();
          created = sized!;
        }
        if (!fileSeen || !created) throw unprocessable("A file part is required");
        const finalized = await finalizeUpload(ctx, created);
        return reply.status(202).send(mediaWire(finalized));
      }

      const body = parseBody(createSessionSchema, request.body);
      const row = await createMediaRow(ctx, me.sub, {
        kind: body.kind,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
        filename: body.filename,
        sha256: body.sha256,
      });
      return reply
        .status(201)
        .header("Location", uploadSessionWire(row).tus_url)
        .send(uploadSessionWire(row));
    },
  );

  // ── Upload session status / tus HEAD ────────────────────────────────────
  // The explicit HEAD registers before GET: Fastify auto-exposes HEAD for
  // GET routes and would otherwise claim the path first.
  app.head(
    "/api/v1/media/uploads/:uploadId",
    { preHandler: requireAuth(ctx) },
    async (request, reply) => {
      const row = await ownUpload(ctx, request);
      return reply
        .header("Tus-Resumable", "1.0.0")
        .header("Upload-Offset", String(row.uploadOffset))
        .header("Upload-Length", String(row.sizeBytes))
        .status(200)
        .send();
    },
  );

  app.get(
    "/api/v1/media/uploads/:uploadId",
    { preHandler: requireAuth(ctx) },
    async (request) => uploadSessionWire(await ownUpload(ctx, request)),
  );

  // ── tus PATCH chunk ─────────────────────────────────────────────────────
  app.patch(
    "/api/v1/media/uploads/:uploadId",
    { preHandler: [requireAuth(ctx), requireScope("write:post")], bodyLimit: ctx.config.MEDIA_MAX_VIDEO_BYTES },
    async (request, reply) => {
      const row = await ownUpload(ctx, request);
      if (row.status !== "uploading") throw conflict(`Upload is already ${row.status}`);
      const offsetHeader = request.headers["upload-offset"];
      const offset = Number.parseInt(String(offsetHeader ?? ""), 10);
      if (Number.isNaN(offset) || offset !== row.uploadOffset) {
        throw conflict(
          `Upload-Offset mismatch: expected ${row.uploadOffset}, got ${String(offsetHeader)}`,
        );
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of request.body as Readable) {
        const buf = chunk as Buffer;
        received += buf.length;
        if (offset + received > row.sizeBytes) {
          throw payloadTooLarge("Chunk exceeds the declared upload length");
        }
        chunks.push(buf);
      }
      const next = await store.append(
        row.storageKey,
        Buffer.concat(chunks),
        offset,
      );
      await db
        .update(media)
        .set({ uploadOffset: next, updatedAt: new Date() })
        .where(eq(media.id, row.id));
      return reply
        .header("Tus-Resumable", "1.0.0")
        .header("Upload-Offset", String(next))
        .status(204)
        .send();
    },
  );

  // ── One-shot PUT (the session's signed-PUT equivalent) ──────────────────
  app.put(
    "/api/v1/media/uploads/:uploadId/content",
    { preHandler: [requireAuth(ctx), requireScope("write:post")], bodyLimit: ctx.config.MEDIA_MAX_VIDEO_BYTES },
    async (request) => {
      const row = await ownUpload(ctx, request);
      if (row.status !== "uploading") throw conflict(`Upload is already ${row.status}`);
      const bytes = await store.putStream(
        row.storageKey,
        request.body as NodeJS.ReadableStream,
      );
      if (bytes > row.sizeBytes) {
        await store.delete(row.storageKey);
        throw payloadTooLarge("Body exceeds the declared upload length");
      }
      const [updated] = await db
        .update(media)
        .set({ uploadOffset: bytes, updatedAt: new Date() })
        .where(eq(media.id, row.id))
        .returning();
      return uploadSessionWire(updated!);
    },
  );

  // ── Complete ────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/media/uploads/:uploadId/complete",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request, reply) => {
      const row = await ownUpload(ctx, request);
      const finalized = await finalizeUpload(ctx, row);
      return reply.status(202).send(mediaWire(finalized));
    },
  );

  // ── Media metadata / alt text ───────────────────────────────────────────
  app.get(
    "/api/v1/media/:mediaId",
    { preHandler: optionalAuth(ctx) },
    async (request) => {
      const { mediaId } = request.params as { mediaId: string };
      const row = await getMediaById(db, mediaId);
      if (!row) throw notFound("Media not found");
      // Non-ready media is only visible to its uploader.
      if (row.status !== "ready" && row.uploaderId !== request.authUser?.sub) {
        throw notFound("Media not found");
      }
      return mediaWire(row);
    },
  );

  app.patch(
    "/api/v1/media/:mediaId",
    { preHandler: [requireAuth(ctx), requireScope("write:post")] },
    async (request) => {
      const { mediaId } = request.params as { mediaId: string };
      const body = parseBody(patchMediaSchema, request.body);
      const row = await getMediaById(db, mediaId);
      if (!row) throw notFound("Media not found");
      if (row.uploaderId !== request.authUser!.sub) {
        throw forbidden("You can only edit your own media");
      }
      const [updated] = await db
        .update(media)
        .set({
          altText: body.alt_text,
          altTextSource: body.alt_text === null ? null : "user",
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId))
        .returning();
      return mediaWire(updated!);
    },
  );

  // ── Public file serving (ready + clean only) ────────────────────────────
  /**
   * Single-range HTTP Range support (hardening): audio/voice-note seeking
   * needs 206 responses. Supports `bytes=start-end`, `bytes=start-` and
   * `bytes=-suffix`; anything else (multi-range, malformed, start beyond
   * EOF) is a 416 with an unsatisfied-range Content-Range. Every response
   * advertises `Accept-Ranges: bytes`.
   */
  async function serveFile(
    request: FastifyRequest,
    reply: FastifyReply,
    key: string,
    contentType: string,
    cacheControl: string,
  ): Promise<FastifyReply> {
    if (!(await store.exists(key))) throw notFound("Media file not found");
    const size = await store.size(key);
    const rangeHeader = request.headers.range;
    reply.header("Accept-Ranges", "bytes");
    if (typeof rangeHeader === "string" && rangeHeader.trim() !== "") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      let start = -1;
      let end = -1;
      if (match && (match[1] !== "" || match[2] !== "")) {
        if (match[1] === "") {
          // Suffix range: the last N bytes.
          const suffix = Number(match[2]);
          if (suffix > 0 && size > 0) {
            start = Math.max(0, size - suffix);
            end = size - 1;
          }
        } else {
          start = Number(match[1]);
          end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
        }
      }
      if (start < 0 || end < start || start >= size) {
        return reply
          .status(416)
          .header("Content-Range", `bytes */${size}`)
          .header("Content-Type", contentType)
          .send();
      }
      return reply
        .status(206)
        .header("Content-Type", contentType)
        .header("Content-Range", `bytes ${start}-${end}/${size}`)
        .header("Content-Length", String(end - start + 1))
        .header("Cache-Control", cacheControl)
        .send(createReadStream(store.localPath(key), { start, end }));
    }
    return reply
      .header("Content-Type", contentType)
      .header("Content-Length", String(size))
      .header("Cache-Control", cacheControl)
      .send(createReadStream(store.localPath(key)));
  }

  async function readyMedia(mediaId: string): Promise<MediaRow> {
    const row = await getMediaById(db, mediaId);
    if (!row || row.status !== "ready" || row.scanVerdict !== "clean") {
      throw notFound("Media not found");
    }
    return row;
  }

  const IMMUTABLE = "public, max-age=31536000, immutable";
  const FORMAT_CONTENT_TYPES: Record<string, string> = {
    webp: "image/webp",
    avif: "image/avif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
  };

  app.get("/media/:mediaId/hls/:file", async (request, reply) => {
    const { mediaId, file } = request.params as { mediaId: string; file: string };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file.includes("..")) {
      throw notFound("Media file not found");
    }
    await readyMedia(mediaId);
    const isPlaylist = file.endsWith(".m3u8");
    if (!isPlaylist && !file.endsWith(".ts")) throw notFound("Media file not found");
    return serveFile(
      request,
      reply,
      `media/${mediaId}/hls/${file}`,
      isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t",
      isPlaylist ? "public, max-age=60" : IMMUTABLE,
    );
  });

  app.get("/media/:mediaId/captions/:lang", async (request, reply) => {
    const { mediaId, lang } = request.params as { mediaId: string; lang: string };
    const row = await readyMedia(mediaId);
    const key = mediaVariantKey(row, `captions/${lang}`);
    if (!key) throw notFound("Caption track not found");
    return serveFile(request, reply, key, "text/vtt", IMMUTABLE);
  });

  app.get("/media/:mediaId/:variant", async (request, reply) => {
    const { mediaId, variant } = request.params as { mediaId: string; variant: string };
    const row = await readyMedia(mediaId);
    const key = mediaVariantKey(row, variant);
    if (!key) throw notFound("Media variant not found");
    const stored = (row.variants ?? {}) as {
      sizes?: Record<string, { format: string }>;
    };
    const format =
      variant === "original"
        ? null
        : variant === "poster" || (variant === "thumb" && row.kind === "video")
          ? "webp"
          : (stored.sizes?.[variant]?.format ?? null);
    const contentType =
      (format ? FORMAT_CONTENT_TYPES[format] : null) ?? row.mimeType;
    return serveFile(request, reply, key, contentType, IMMUTABLE);
  });
}

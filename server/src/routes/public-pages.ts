import { Router } from "express";
import { createReadStream, promises as fsp } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Db } from "@paperclipai/db";
import { workProductService } from "../services/work-products.js";
import { issueService } from "../services/issues.js";

// Landing-page media (hero video + generated stills) lives in the
// marketing-engine repo's assets/ dir, bind-mounted into this container at
// /repo (docker-compose `.:/repo`). Each page's work-product metadata carries a
// `media` map { key: { path, contentType } } with paths relative to assets/.
const REPO_ASSETS_DIR = process.env.REPO_ASSETS_DIR || "/repo/assets";

// Public, unauthenticated serving of approved landing pages / lead forms.
//
// Pages are stored as native issue_work_products (type "preview_url") whose
// metadata carries { subdomain, slug, html }. A page only becomes live once it
// clears board review (reviewState "approved"). Each company gets its own
// subdomain, e.g. https://bea.nexlessclip.com/p/<slug>; the company is resolved
// from the leading Host label, and the matching work-product carries companyId.
//
// NOTE (carried fork edit): this route is white-label infrastructure for the
// nexless-marketing-engine stack. Re-apply after any upstream merge. See
// nexless-marketing-engine/KNOWN_ISSUES.md.

const NOT_FOUND_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
  "<title>Not found</title></head><body style=\"font-family:system-ui;text-align:center;padding:4rem\">" +
  "<h1>404</h1><p>This page is not available.</p></body></html>";

function subdomainOf(host: string | undefined): string {
  return (host || "").split(":")[0].toLowerCase().split(".")[0];
}

function cappedString(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function publicPagesRoutes(db: Db) {
  const router = Router();
  const workProducts = workProductService(db);
  const issues = issueService(db);

  // Serve an approved page's HTML.
  router.get("/p/:slug", async (req, res) => {
    const wp = await workProducts.getPublishedBySlug(subdomainOf(req.hostname), req.params.slug);
    const html = wp?.metadata?.html;
    if (!wp || typeof html !== "string") {
      res.status(404).type("html").send(NOT_FOUND_HTML);
      return;
    }
    res.status(200).type("html").send(html);
  });

  // Serve an approved page's media (hero video / generated images) from the
  // bind-mounted assets/ dir. Only paths listed in the page's metadata.media are
  // served, and the resolved path must stay inside REPO_ASSETS_DIR (no traversal).
  // Supports HTTP range requests so <video> playback/seeking works.
  router.get("/p/:slug/media/:key", async (req, res) => {
    const wp = await workProducts.getPublishedBySlug(subdomainOf(req.hostname), req.params.slug);
    const media = (wp?.metadata?.media ?? {}) as Record<string, { path?: string; contentType?: string }>;
    const entry = media[req.params.key];
    if (!wp || !entry?.path) {
      res.status(404).end();
      return;
    }
    const base = resolvePath(REPO_ASSETS_DIR);
    const full = resolvePath(base, entry.path);
    if (full !== base && !full.startsWith(base + "/")) {
      res.status(403).end();
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", entry.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(full, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", String(stat.size));
      createReadStream(full).pipe(res);
    }
  });

  // Accept a form submission from a live page. Creates a "[lead]" issue in the
  // page's company (description-JSON carrier, matching the lead reader used by
  // the marketing-api and the Acuity sync).
  router.post("/p/:slug/submit", async (req, res) => {
    const wp = await workProducts.getPublishedBySlug(subdomainOf(req.hostname), req.params.slug);
    if (!wp) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = cappedString(body.email, 320).trim();
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    const name =
      cappedString(body.name, 200).trim() ||
      [cappedString(body.firstName, 100), cappedString(body.lastName, 100)].filter(Boolean).join(" ").trim() ||
      email;

    const description = JSON.stringify({
      name,
      email,
      phone: cappedString(body.phone, 50),
      message: cappedString(body.message, 4000),
      source: `page:${req.params.slug}`,
      score: 0,
      stage: "new",
      capturedAt: new Date().toISOString(),
    });

    await issues.create(wp.companyId, {
      title: `[lead] ${name}`,
      description,
    });

    // Keep the page's submission counter accurate.
    const meta = (wp.metadata ?? {}) as Record<string, unknown>;
    await workProducts.update(wp.id, {
      metadata: { ...meta, submissionCount: ((meta.submissionCount as number) ?? 0) + 1 },
    });

    // Hand the captured lead off to booking (e.g. Acuity) if the page set a URL.
    const bookingUrl = typeof meta.bookingUrl === "string" ? meta.bookingUrl : null;
    res.status(201).json({ status: "captured", bookingUrl });
  });

  return router;
}

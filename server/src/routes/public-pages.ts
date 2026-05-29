import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { workProductService } from "../services/work-products.js";
import { issueService } from "../services/issues.js";

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

    res.status(201).json({ status: "captured" });
  });

  return router;
}

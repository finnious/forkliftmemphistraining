/**
 * Cloudflare Pages Function: POST /api/lead
 *
 * Creates or updates a Creating Value LLC GoHighLevel contact (LeadConnector)
 * and applies forklift lead tags. Messages are stored as a contact note so
 * upsert does not wipe tags already on the contact.
 *
 * Required Pages secrets / variables:
 *   GHL_API_KEY      LeadConnector private integration token (location)
 *   GHL_LOCATION_ID  Sub-account location id
 * Optional:
 *   GHL_TAGS         Comma-separated base tags. Defaults to
 *                    forklift, source-forkliftmemphistraining
 *   GHL_API_VERSION  Version header. Defaults to 2021-07-28
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_VERSION = "2021-07-28";
const DEFAULT_TAGS = ["forklift", "source-forkliftmemphistraining"];

const FORM_TAGS = {
  "forklift-home": "forklift-home",
  "forklift-home-lead": "forklift-home",
  "forklift-contact": "forklift-contact",
  "forklift-near-me": "forklift-near-me",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return errorResponse(context.request, "Method not allowed.", 405);
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (err) {
    logEvent(
      "lead_unhandled",
      { message: err instanceof Error ? err.message : "unknown" },
      "error",
    );
    return errorResponse(
      context.request,
      "We could not deliver your message right now. Please try again in a few minutes.",
      502,
    );
  }
}

async function handlePost(context) {
  const { request, env } = context;
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > 100_000) {
    return errorResponse(request, "That message is too large.", 413);
  }

  const apiKey = String(env.GHL_API_KEY || "").trim();
  const locationId = String(env.GHL_LOCATION_ID || "").trim();
  if (!apiKey || !locationId) {
    logEvent(
      "lead_missing_env",
      { hasKey: Boolean(apiKey), hasLocation: Boolean(locationId) },
      "error",
    );
    return errorResponse(
      request,
      "Lead delivery is not configured yet. Set GHL_API_KEY and GHL_LOCATION_ID in the Cloudflare Pages project settings (scott@creatingvaluellc.com).",
      503,
    );
  }

  const parsed = await readFields(request);
  if (parsed.error === "unsupported-type") {
    return errorResponse(
      request,
      "Send the form as application/x-www-form-urlencoded or JSON.",
      415,
    );
  }
  if (parsed.error === "invalid-json") {
    return errorResponse(request, "The request body was not valid JSON.", 400);
  }

  const name = clip(field(parsed.fields, "name"), 120);
  const email = clip(field(parsed.fields, "email"), 320).toLowerCase();
  const phoneRaw = clip(field(parsed.fields, "phone"), 40);
  const company = clip(field(parsed.fields, "company"), 200);
  const message = clip(field(parsed.fields, "message"), 4000);
  const formId = clip(field(parsed.fields, "formId"), 64);

  if (!name || !email) {
    return errorResponse(request, "Name and email are required.", 400);
  }
  if (!EMAIL_RE.test(email)) {
    return errorResponse(request, "Enter a valid email address.", 400);
  }

  const phone = normalizePhone(phoneRaw);
  const names = splitName(name);
  const tags = tagsFor(env, formId);
  const version = String(env.GHL_API_VERSION || DEFAULT_VERSION).trim() || DEFAULT_VERSION;

  const contactBody = {
    locationId,
    email,
    firstName: names.firstName,
    name,
    source: "forkliftmemphistraining.com",
  };
  if (names.lastName) contactBody.lastName = names.lastName;
  if (phone) contactBody.phone = phone;
  if (company) contactBody.companyName = company;

  let upsert = await ghl(apiKey, version, "/contacts/upsert", contactBody);
  let phoneDropped = false;
  if (!upsert.ok && phone && isPhoneError(upsert)) {
    delete contactBody.phone;
    phoneDropped = true;
    upsert = await ghl(apiKey, version, "/contacts/upsert", contactBody);
  }
  if (!upsert.ok) {
    logEvent("ghl_upsert_failed", { status: upsert.status, formId: formId || null }, "error");
    return errorResponse(
      request,
      "We could not deliver your message right now. Please try again in a few minutes.",
      502,
    );
  }

  const contactId = readContactId(upsert.json);
  if (!contactId) {
    logEvent("ghl_upsert_missing_id", { status: upsert.status, formId: formId || null }, "error");
    return errorResponse(
      request,
      "We could not deliver your message right now. Please try again in a few minutes.",
      502,
    );
  }

  const tagged = await ghl(apiKey, version, `/contacts/${encodeURIComponent(contactId)}/tags`, {
    tags,
  });
  if (!tagged.ok) {
    logEvent("ghl_tags_failed", { status: tagged.status, formId: formId || null }, "error");
    return errorResponse(
      request,
      "We could not deliver your message right now. Please try again in a few minutes.",
      502,
    );
  }

  const note = noteBody({
    formId,
    message,
    phoneRaw,
    phone: phoneDropped ? "" : phone,
    company,
  });
  if (note) {
    const noted = await ghl(apiKey, version, `/contacts/${encodeURIComponent(contactId)}/notes`, {
      body: note,
      title: "Forklift Memphis Training inquiry",
    });
    if (!noted.ok) {
      logEvent("ghl_note_failed", { status: noted.status, formId: formId || null }, "error");
      return errorResponse(
        request,
        "We could not deliver your message right now. Please try again in a few minutes.",
        502,
      );
    }
  }

  logEvent("lead_saved", { formId: formId || null, created: Boolean(upsert.json && upsert.json.new) });
  return thankYou();
}

function tagsFor(env, formId) {
  const fromEnv = String(env.GHL_TAGS || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const base = fromEnv.length ? fromEnv : DEFAULT_TAGS.slice();
  const formTag = FORM_TAGS[formId];
  const tags = formTag ? base.concat(formTag) : base;
  return [...new Set(tags)];
}

function noteBody({ formId, message, phoneRaw, phone, company }) {
  const phoneNote = phoneRaw && !phone;
  if (!message && !phoneNote) return "";
  const lines = [];
  if (formId) lines.push(`Form: ${formId}`);
  if (company) lines.push(`Company: ${company}`);
  if (phoneNote) lines.push(`Phone as entered: ${phoneRaw}`);
  if (message) {
    if (lines.length) lines.push("");
    lines.push(message);
  }
  return lines.join("\n").trim();
}

function splitName(name) {
  const parts = name.split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

function isPhoneError(result) {
  return `${result.text || ""}`.toLowerCase().includes("phone");
}

function readContactId(json) {
  if (!json || typeof json !== "object") return "";
  if (json.contact && typeof json.contact.id === "string") return json.contact.id;
  if (typeof json.id === "string") return json.id;
  return "";
}

async function ghl(apiKey, version, path, body) {
  const response = await fetch(`${GHL_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: version,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ok: response.ok, status: response.status, json, text: text.slice(0, 500) };
}

async function readFields(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    let data;
    try {
      data = await request.json();
    } catch {
      return { error: "invalid-json" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { error: "invalid-json" };
    }
    return { fields: data };
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const fields = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    return { fields };
  }
  return { error: "unsupported-type" };
}

function field(fields, key) {
  const value = fields[key];
  return typeof value === "string" ? value.trim() : "";
}

function clip(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

function wantsHtml(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) return false;
  if (accept.includes("text/html")) return true;
  return !contentType.includes("application/json");
}

function errorResponse(request, message, status) {
  if (!wantsHtml(request)) {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Message not sent | Forklift Training Memphis</title>
  <meta name="robots" content="noindex">
  <style>
    body{font-family:'Open Sans',Arial,sans-serif;margin:0;background:#fff;color:#333;line-height:1.6}
    main{max-width:640px;margin:4rem auto;padding:0 1.2rem}
    h1{color:#2ea3f2}
    a{color:#2ea3f2;font-weight:700}
  </style>
</head>
<body>
  <main>
    <h1>Message not sent</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="javascript:history.back()">Go back</a> or <a href="/contact-us.html">return to the contact form</a>.</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function thankYou() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/thank-you.html",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logEvent(event, details, level = "info") {
  console.log(JSON.stringify({ level, event, ...details }));
}

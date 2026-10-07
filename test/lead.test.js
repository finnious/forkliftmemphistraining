import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { onRequest, onRequestPost } from "../functions/api/lead.js";

const originalFetch = globalThis.fetch;
const calls = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

function env(extra = {}) {
  return {
    GHL_API_KEY: "pit-test",
    GHL_LOCATION_ID: "loc_123",
    ...extra,
  };
}

function mockGhl({ upsertStatus = 201, tagStatus = 201, noteStatus = 201, upsertBody } = {}) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    if (String(url).endsWith("/contacts/upsert")) {
      return jsonResponse(
        upsertBody || { new: true, contact: { id: "contact_1" } },
        upsertStatus,
      );
    }
    if (String(url).endsWith("/tags")) {
      return jsonResponse({ tags: body.tags }, tagStatus);
    }
    if (String(url).endsWith("/notes")) {
      return jsonResponse({ note: { id: "note_1" } }, noteStatus);
    }
    return jsonResponse({ message: "unexpected" }, 500);
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function post(body, headers = {}) {
  const isJson = headers["content-type"] === "application/json";
  return new Request("https://www.forkliftmemphistraining.com/api/lead", {
    method: "POST",
    headers,
    body: isJson ? JSON.stringify(body) : new URLSearchParams(body),
  });
}

describe("POST /api/lead", () => {
  it("returns 503 when GHL env is missing and does not call GoHighLevel", async () => {
    mockGhl();
    const response = await onRequestPost({
      request: post(
        { name: "Ada Lovelace", email: "ada@example.com" },
        { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      ),
      env: {},
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.match(payload.error, /GHL_API_KEY/);
    assert.match(payload.error, /GHL_LOCATION_ID/);
    assert.equal(calls.length, 0);
  });

  it("requires name and email", async () => {
    mockGhl();
    const response = await onRequestPost({
      request: post(
        { name: " ", email: "ada@example.com", formId: "forklift-home" },
        { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      ),
      env: env(),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Name and email/);
    assert.equal(calls.length, 0);
  });

  it("rejects an invalid email", async () => {
    mockGhl();
    const response = await onRequestPost({
      request: post(
        { name: "Ada", email: "not-an-email" },
        { "content-type": "application/json", accept: "application/json" },
      ),
      env: env(),
    });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });

  it("upserts a contact, adds tags without sending tags on upsert, and redirects", async () => {
    mockGhl();
    const response = await onRequestPost({
      request: post(
        {
          name: "Ada Lovelace",
          email: "Ada@Example.com",
          phone: "(901) 555-0100",
          company: "River Warehouse",
          message: "Need a Friday class",
          formId: "forklift-home",
        },
        { "content-type": "application/x-www-form-urlencoded" },
      ),
      env: env(),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), "/thank-you.html");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].headers.Authorization, "Bearer pit-test");
    assert.equal(calls[0].headers.Version, "2021-07-28");
    assert.equal(calls[0].body.locationId, "loc_123");
    assert.equal(calls[0].body.email, "ada@example.com");
    assert.equal(calls[0].body.firstName, "Ada");
    assert.equal(calls[0].body.lastName, "Lovelace");
    assert.equal(calls[0].body.phone, "+19015550100");
    assert.equal(calls[0].body.companyName, "River Warehouse");
    assert.equal(calls[0].body.tags, undefined);
    assert.deepEqual(calls[1].body.tags, [
      "forklift",
      "source-forkliftmemphistraining",
      "forklift-home",
    ]);
    assert.match(calls[1].url, /\/contacts\/contact_1\/tags$/);
    assert.match(calls[2].body.body, /Need a Friday class/);
    assert.match(calls[2].url, /\/contacts\/contact_1\/notes$/);
  });

  it("accepts JSON and maps each form id to its tag", async () => {
    for (const [formId, tag] of [
      ["forklift-contact", "forklift-contact"],
      ["forklift-near-me", "forklift-near-me"],
      ["forklift-home-lead", "forklift-home"],
    ]) {
      calls.length = 0;
      mockGhl();
      const response = await onRequestPost({
        request: post(
          { name: "Sam", email: "sam@example.com", formId },
          { "content-type": "application/json", accept: "application/json" },
        ),
        env: env(),
      });
      assert.equal(response.status, 303);
      assert.equal(calls.length, 2);
      assert.ok(calls[1].body.tags.includes(tag));
    }
  });

  it("uses GHL_TAGS when set and ignores unknown form ids", async () => {
    mockGhl();
    const response = await onRequestPost({
      request: post(
        { name: "Sam", email: "sam@example.com", formId: "ignore-me" },
        { "content-type": "application/json" },
      ),
      env: env({ GHL_TAGS: "custom-a, custom-b" }),
    });
    assert.equal(response.status, 303);
    assert.deepEqual(calls[1].body.tags, ["custom-a", "custom-b"]);
  });

  it("keeps an unusable phone off the contact and puts it in the note", async () => {
    mockGhl();
    const response = await onRequestPost({
      request: post(
        { name: "Sam", email: "sam@example.com", phone: "call me", formId: "forklift-contact" },
        { "content-type": "application/json" },
      ),
      env: env(),
    });
    assert.equal(response.status, 303);
    assert.equal(calls[0].body.phone, undefined);
    assert.match(calls[2].body.body, /Phone as entered: call me/);
  });

  it("retries upsert without phone when GoHighLevel rejects the number", async () => {
    let upserts = 0;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/contacts/upsert")) {
        upserts += 1;
        if (upserts === 1) {
          return jsonResponse({ message: "phone is invalid" }, 400);
        }
        return jsonResponse({ new: false, contact: { id: "contact_9" } }, 200);
      }
      if (String(url).endsWith("/tags")) return jsonResponse({ tags: body.tags }, 201);
      return jsonResponse({ note: { id: "n" } }, 201);
    };
    const response = await onRequestPost({
      request: post(
        { name: "Sam", email: "sam@example.com", phone: "9015550199", message: "Hi" },
        { "content-type": "application/json" },
      ),
      env: env(),
    });
    assert.equal(response.status, 303);
    assert.equal(calls[0].body.phone, "+19015550199");
    assert.equal(calls[1].body.phone, undefined);
    assert.match(calls[2].url, /contact_9\/tags$/);
  });

  it("returns 502 when GoHighLevel rejects the upsert", async () => {
    mockGhl({ upsertStatus: 401, upsertBody: { message: "unauthorized" } });
    const response = await onRequestPost({
      request: post(
        { name: "Sam", email: "sam@example.com" },
        { "content-type": "application/json", accept: "application/json" },
      ),
      env: env(),
    });
    assert.equal(response.status, 502);
    assert.equal(calls.length, 1);
  });

  it("returns 415 for an unsupported content type", async () => {
    mockGhl();
    const request = new Request("https://www.forkliftmemphistraining.com/api/lead", {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "application/json" },
      body: "name=Sam",
    });
    const response = await onRequestPost({ request, env: env() });
    assert.equal(response.status, 415);
    assert.equal(calls.length, 0);
  });

  it("returns 405 for non-POST", async () => {
    const request = new Request("https://www.forkliftmemphistraining.com/api/lead", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const response = await onRequest({ request, env: env() });
    assert.equal(response.status, 405);
  });
});

# forkliftmemphistraining

Forklift Training Class is needed for a certification. Get Certified and ready to hire Today. Click to see this month's special...

Static marketing site for www.forkliftmemphistraining.com. GitHub Pages currently serves `www` (see `CNAME`). Lead forms are ready for Cloudflare Pages and post into Creating Value LLC GoHighLevel. Do not change DNS from this repo.

## Lead forms

These pages include an HTML form (`method="POST"` `action="/api/lead"`):

| Page | `formId` | Extra tag |
|------|----------|-----------|
| `index.html` | `forklift-home` | `forklift-home` |
| `contact-us.html` | `forklift-contact` | `forklift-contact` |
| `forklift-training-near-me.html` | `forklift-near-me` | `forklift-near-me` |

Fields: name (required), email (required), phone, company, message. A successful post returns **303** to `/thank-you.html`.

`functions/api/lead.js` accepts `application/x-www-form-urlencoded` or JSON. It upserts a contact with the LeadConnector API (`https://services.leadconnectorhq.com/contacts/upsert`, `Version: 2021-07-28`), then adds tags with `POST /contacts/:id/tags` so existing tags are not replaced. A message (and a phone number GoHighLevel will not accept) is saved as a contact note.

Base tags are `forklift` and `source-forkliftmemphistraining`, plus the form tag above.

## Cloudflare Pages

Account: **scott@creatingvaluellc.com**.

1. Workers & Pages → Create → Pages → Connect to Git → `finnious/forkliftmemphistraining`.
2. Framework preset: **None**.
3. Build command: *(empty)*.
4. Build output directory: **`/`** (repository root).
5. Leave Pages Functions enabled. `functions/api/lead.js` is served at `/api/lead`. No Node build is required.

Then **Settings → Variables and Secrets**:

| Name | Type | Required | Purpose |
|------|------|----------|---------|
| `GHL_API_KEY` | **Secret** | Yes | LeadConnector private integration token for the CVLLC location. Needs contact write access. |
| `GHL_LOCATION_ID` | Variable or Secret | Yes | GoHighLevel location id for Creating Value LLC. |
| `GHL_TAGS` | Variable | No | Comma-separated base tags. When set, these replace `forklift` and `source-forkliftmemphistraining`. The form tag is still added. |
| `GHL_API_VERSION` | Variable | No | `Version` header. Defaults to `2021-07-28`. |

Set the same values for Production and Preview if preview URLs should accept leads.

If `GHL_API_KEY` or `GHL_LOCATION_ID` is missing, `POST /api/lead` returns **503** with a message naming those variables. The static site still builds. GitHub Pages does not run Functions, so a submit on the current `www` host 404s until this project is served by Cloudflare Pages with the variables set. Confirm the form on the `*.pages.dev` URL before any DNS cutover.

The function writes structured JSON logs (`event`, `status`, `formId`). It does not log the API key, email, phone, or message. Enable Workers Logs on the Pages project to see them in the dashboard.

## Open Graph image

`forklift-training-class.jpg` is not in this repository and returns 404 on the live site. The homepage `og:image` now uses `/forkliftmemphistraining.jpg` (1248×832), which is already in the repo and used by the Twitter card. Do not add a placeholder image file.

## Tests

```bash
node --experimental-default-type=module --test test/lead.test.js
```

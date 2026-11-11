# TrustLance

**AI-powered milestone escrow for freelancers and clients.**

## Try it as a judge

- **Live Demo:** https://trustlance-n5ti.onrender.com
- **Cold-start note:** The app runs on Render's free tier, so the first request may take up to a minute to wake up.

### Walkthrough Steps

1. **Create a job (Client):** Enter a plain-English work description and a USD budget (or click a sample prompt), click **Generate AI Checklist**, optionally edit or remove criteria, and click **Create job**.
2. **Accept the job (Freelancer):** On the `/job/:id` page, use the `Viewing as: Client | Freelancer` toggle at the top to switch to **Freelancer** and click **Accept Job**.
3. **Fund the escrow (Client):** Switch the top toggle back to **Client**, click **Fund job**, and approve the PayPal Sandbox hold using the test buyer login below.
4. **Submit & settle (Freelancer):** Switch back to **Freelancer** (you will see **Payment secured**), paste text/code or enter a public URL, and click **Submit Work for AI Review**. Gemini evaluates every checklist item and PayPal automatically captures the pro-rata payout (`final_capture: true`) or voids the hold if `$0.00` passes.

### Sandbox Buyer Login

- **Email:** sb-gdlyf53857906@personal.example.com
- **Password:** wK7^l5DS

*(These are PayPal Sandbox test credentials only — no real money is charged or moved.)*

---

## The Problem & Who It Is For

Freelancers and independent clients often face a trust gap on short-to-medium deliverables:
- **Clients** worry about paying upfront before verifying that every requirement was actually delivered.
- **Freelancers** worry about delivering completed work before knowing the funds are secured.

**TrustLance** bridges that gap for solo freelancers, agencies, and clients hiring for verifiable text, code, or web deliverables. Instead of holding money blindly or requiring manual escrow arbitration, TrustLance converts a plain-English scope into an objective checklist, places a PayPal authorization hold on the full budget, and uses AI verification to settle the exact earned payout automatically.

---

## How It Works (Step by Step)

1. **Client creates a job:** The client enters a plain-English description of the work and a USD budget. Gemini generates 3 to 6 specific, verifiable checklist criteria as JSON. The client can edit or remove items before publishing a shareable job page (`/job/:id`). Status: `Waiting for freelancer`.
2. **Freelancer accepts:** The freelancer opens the shared link (demo mode provides a `Viewing as: Client | Freelancer` toggle at the top of each job page), reviews the checklist and price, and clicks **Accept**. Status: `Accepted, waiting for funding`.
3. **Client funds the escrow:** The client clicks **Fund job**, approving a PayPal Sandbox checkout order (`intent: AUTHORIZE`). PayPal redirects back to `/jobs/:id/paypal/return`, the server authorizes the hold, and both sides see the hold (`Payment secured` on the freelancer view). Status: `Funded`.
4. **Freelancer submits the deliverable:** The freelancer submits either pasted text/code or a public URL (the server fetches readable HTML/text up to 15,000 characters). Status: `Under AI review`.
5. **AI review & server-side payout calculation:** Gemini evaluates every checklist item (`passed: true/false` + a one-sentence reason) and returns a short overall summary as strict JSON. The **server** computes the payout strictly in cents:
   $$\text{Payout} = \lfloor \text{Price} \times (\text{Passed Items} / \text{Total Items}) \rfloor$$
6. **Automatic PayPal settlement:**
   - If payout > `$0.00`, the server captures the exact payout amount from the authorization with `final_capture: true`, releasing any uncaptured remainder back to the client.
   - If payout is `$0.00`, the server voids the authorization so nothing is charged.
   - Both sides see the final result screen with per-item pass/fail reasons, payout amount, amount returned to client, and PayPal Capture ID. Status: `Completed`.

---

## PayPal Features Used

TrustLance integrates directly with the **PayPal Sandbox REST API** (`https://api-m.sandbox.paypal.com`):

- **OAuth 2.0 Client Credentials** (`POST /v1/oauth2/token`): Server-side access token generation from `PAYPAL_CLIENT_ID` and `PAYPAL_SECRET`.
- **Orders v2 with `intent: "AUTHORIZE"`** (`POST /v2/checkout/orders`): Places a payment authorization hold without immediately capturing funds, with job-specific `return_url` and `cancel_url`.
- **Order Authorization** (`POST /v2/checkout/orders/{order_id}/authorize`): Locks the authorized funds after buyer approval, guarded by per-job locks and idempotency checks so refreshes/double-clicks never re-authorize.
- **Partial / Final Capture** (`POST /v2/payments/authorizations/{authorization_id}/capture`): Captures the exact server-calculated payout with `final_capture: true`, automatically releasing the uncaptured balance back to the buyer.
- **Authorization Void** (`POST /v2/payments/authorizations/{authorization_id}/void`): Voids the hold when `0` checklist items pass (`$0.00` payout).
- **Standalone Sandbox Probe (`/test`)**: Preserves the original $40 authorize / $30 partial capture verification flow at `/test`.

---

## How Gemini Is Used

TrustLance uses the official `@google/genai` SDK with strict JSON output mode (`responseMimeType: "application/json"` and `responseJsonSchema`):

1. **Checklist Generation (`generateChecklist`)**: Converts the client's plain-English scope into a concise title and 3 to 6 measurable criteria.
2. **Deliverable Evaluation (`evaluateSubmission`)**: Evaluates the submitted text/code or fetched webpage against each numbered criterion, returning boolean `passed`, a one-sentence `reason`, and an overall `summary`. Payout math is never delegated to the AI.
3. **Reliability & Safeguards**:
   - **JSON Validation Retry**: Invalid or schema-mismatched JSON responses automatically trigger 1 validation retry.
   - **Transient Error Retries & Model Fallback**: On `503`, `429`, or timeouts, the server retries up to 3 times with a 2-second delay and then falls back through `GEMINI_FALLBACK_MODELS` (defaulting to `gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash`).
   - **Fail-Safe Escrow**: If AI review fails, **no PayPal capture or void is executed**; both sides see a friendly error message and a **Try again** button.

---

## Setup & Run Instructions

### Local Development

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/saruu0612-dotcom/paypal-ai-assistant.git
   cd paypal-ai-assistant
   npm install
   ```
2. **Create your `.env` file:**
   ```bash
   cp .env.example .env
   ```
   Fill in your PayPal Sandbox and Gemini API credentials in `.env`.
3. **Start the server:**
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in your browser (and `http://localhost:3000/test` for the PayPal Sandbox authorize/capture test page).

### Deploying on Render

1. Create a new **Web Service** on Render connected to this repository.
2. **Build Command:** `npm install`
3. **Start Command:** `npm start`
4. Add the environment variables below in Render's **Environment** settings, setting `BASE_URL` to your live Render URL (e.g. `https://your-app.onrender.com`).
5. The server automatically binds to `0.0.0.0` on `process.env.PORT`.

---

## Environment Variables

| Variable | Required | Description |
| :--- | :---: | :--- |
| `PAYPAL_CLIENT_ID` | Yes | PayPal Sandbox REST app Client ID |
| `PAYPAL_SECRET` | Yes | PayPal Sandbox REST app Secret |
| `GEMINI_API_KEY` | Yes | Google AI Studio / Gemini API key |
| `GEMINI_MODEL` | No | Primary Gemini model (defaults to `gemini-3.8-flash`) |
| `GEMINI_FALLBACK_MODELS` | No | Comma-separated fallback models on 503/429/timeout (defaults to `gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash`) |
| `BASE_URL` | Recommended | Public app origin without trailing slash (e.g. `https://your-app.onrender.com`); used for PayPal return/cancel URLs and generated share links |
| `PORT` | No | Server listen port (defaults to `3000`; automatically provided on Render) |

---

## Sandbox Test Buyer

To test the PayPal Sandbox funding checkout flow, log in with the sandbox buyer credentials above or create your own PayPal Sandbox **Personal (Buyer)** account in your [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/accounts) when redirected to PayPal:

- **Buyer Email:** sb-gdlyf53857906@personal.example.com
- **Buyer Password:** wK7^l5DS

*(These are PayPal Sandbox test credentials with no real money. Never commit live production credentials or API keys into this repository.)*

---

## Honest Limitations

- **Sandbox only:** Hardcoded to `https://api-m.sandbox.paypal.com`; no real money is moved and live production PayPal credentials will not work without changing the API base and adding production hardening.
- **Authorization expiration (~29 days):** PayPal payment authorizations expire after approximately 29 days (with a ~3-day honor period). Jobs left unreviewed past expiration cannot be captured.
- **Text-readable deliverables only:** Gemini can only judge what it can read — pasted text/code or public `http://`/`https://` HTML/text responses capped at 15,000 characters. It cannot inspect password-protected sites, binary attachments, local files, or rendered screenshots.
- **Ephemeral file persistence:** Jobs are kept in memory and persisted to a local `data.json` file rather than a database. On hosts with ephemeral disks like Render's free/standard web services, stored jobs reset on redeploy or instance restart.
- **Demo mode roles:** The `Viewing as: Client | Freelancer` switcher is designed for demonstration and evaluation without user login/authentication.

---

## Tools & Stack

- **Runtime & Server:** Node.js (`>=22.0.0`), Express
- **AI Verification:** Google Gemini API via `@google/genai`
- **Payments:** PayPal REST APIs (OAuth 2.0, Orders v2 `AUTHORIZE`, Payments v2 Capture & Void)
- **Configuration & Hosting:** `dotenv`, Render

---

## License

This project is **MIT licensed**. See [LICENSE](./LICENSE) for full details.

# ResolveAI

ResolveAI is a customer-support and refund-resolution workspace. It connects complaints to sample customers and orders, retrieves relevant local policy passages, runs deterministic eligibility rules, and sends uncertain or high-value cases to human review. AI can help explain a case, but it cannot approve or execute a refund.

> This is a functional starter and demo, not a production payment or identity system. Refunds are simulations and never move money. Use your organization's policies and authentication provider before deployment.

## Requirements

- Windows 10/11 with PowerShell
- Node.js 20 or newer (npm is included)
- VS Code (optional but useful)
- MongoDB Community Server or MongoDB Atlas only if you want persistent storage; demo mode does not require MongoDB
- An OpenAI API key only if you want live AI explanations; demo mode works without a paid key

## Quick start: Windows demo mode

Open PowerShell in `D:\resolveai`.

```powershell
npm.cmd install
if (-not (Test-Path server/.env)) { Copy-Item server/.env.example server/.env }
$env:NODE_ENV = "development"
$env:MONGODB_URI = ""
$env:OPENAI_API_KEY = ""
npm.cmd run dev
```

Keep that terminal open while you use the app. Open **http://127.0.0.1:5173**. The API is at **http://127.0.0.1:4000**. Stop both services safely with **Ctrl+C** in the terminal that ran `npm.cmd run dev`.

The example `.env` values are blank for MongoDB and OpenAI. The PowerShell assignments above explicitly select in-memory, no-key mode even if those variables are set elsewhere in your current terminal. In-memory demo records reset when the backend stops.

## Demo access

The local demo starts as an agent. Switch roles using the circular arrows beside the profile at the bottom of the sidebar, or in **Settings**.

- Agent token: `resolveai-agent-demo`
- Administrator token: `resolveai-admin-demo`

These fixed tokens are for local demonstration only. They are not secure production credentials. For a deployment, set private `DEMO_AGENT_TOKEN` and `DEMO_ADMIN_TOKEN` values in `server/.env`, set `NODE_ENV=production`, and replace this demo auth layer with your identity provider before exposing the service.

## Complaint-to-resolution workflow

1. Open **Support inbox** and create a complaint. You can use a seeded customer email or enter a new one; add an order ID when available.
2. Select the case and choose **Investigate case**. ResolveAI classifies the issue, verifies the order and customer, applies deterministic refund rules, and retrieves policy chunks with source citations. Results label semantic-vector retrieval or the keyword fallback.
3. Review the recommendation. The demo classifier and explanation are marked **DEMO RESULT**. Missing orders, ownership mismatches, fraud signals, duplicate charges, uncertain delivery, policy exceptions, and high-value cases go to human review.
4. An eligible low-risk case can create a **simulated refund**. High-value cases wait in **Human review**. Switch to the demo administrator to approve or reject a pending request, then simulate an approved refund.
5. **No payment is sent or real money moved.** Investigation, approval, rejection, and simulation actions appear in the audit history.

## MongoDB setup (optional)

Install MongoDB Community Server and make sure its local service is running, or create an Atlas cluster and get its connection string. Edit `server/.env`:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/resolveai
```

Restart ResolveAI. The Settings page and `/api/health` identify MongoDB mode when connected. If MongoDB cannot be reached within the connection timeout, the app clearly logs that it is using temporary in-memory demo mode instead. Do not treat that mode as persistent storage.

Seed the sample customers, orders, policies, and complaints into a configured MongoDB database:

```powershell
npm.cmd run seed
```

The seed command is idempotent for non-empty collections. It does not delete records. Without `MONGODB_URI`, it only reports that the in-memory demo seed is ready.

### What survives a restart

- With the default blank `MONGODB_URI`, seeded demo customers/orders/cases are loaded again at startup, but cases you create, investigations, refund requests, audit events, and status changes made during the session live only in memory and are lost when the backend stops.
- With a working MongoDB URI, those application records are stored in MongoDB and loaded again on startup. `/api/health` and Settings must report `database: mongodb` before treating this as active; merely setting a URI is not proof of persistence.
- The policy vector index is separate from customer data. `server/.resolveai/policy-vectors.json` persists on disk across app restarts and can be rebuilt from the canonical synthetic Markdown files with `npm.cmd run rag:index`.

## OpenAI setup (optional)

Create a private key through your OpenAI account and put it only in `server/.env`:

```dotenv
OPENAI_API_KEY=your-private-key
OPENAI_MODEL=gpt-4o-mini
```

Restart the server. The key is read by the backend only and is never sent to the frontend. Deterministic rules still decide eligibility; the model only writes a case explanation using retrieved evidence. A provider error produces an explicitly labeled `rules` fallback. Do not commit `server/.env` or place secrets in any `VITE_` variable.

## Local policy RAG (optional, no paid service)

The source of truth is the synthetic Markdown policy collection in `server/policies/`. Each file has an ID, title, category, version, effective date, active/superseded status, and an explicit synthetic-data marker. The backend parses the files, selects the latest active version, chunks policy text with overlap, and attaches the canonical chunk ID as its stable citation ID. Investigation evidence includes the source filename, policy ID, version, chunk ID, and exact canonical excerpt. AI explanations are shown only when every bracketed citation matches a chunk retrieved for that investigation; missing, malformed, fabricated, or unrelated citations cause the AI text to be rejected and replaced by the deterministic rules explanation.

The app starts without downloading an embedding model. Until you build the vector index, search and investigation use a clearly labeled keyword fallback. That fallback is not semantic RAG. To enable genuine local semantic embeddings, run these commands in PowerShell from `D:\resolveai`:

```powershell
npm.cmd install @huggingface/transformers --workspace server
npm.cmd run rag:index
```

The first indexing run downloads Hugging Face's open `Xenova/all-MiniLM-L6-v2` ONNX model into the Transformers.js cache. Internet is needed for this one-time model download; its quantized file is about 23 MB. The command embeds active policy chunks and writes a rebuildable JSON vector index under `server/.resolveai/`, which is ignored by Git. At query time, the backend expands common customer wording with a small general synonym list, embeds the complaint, and ranks vectors by cosine similarity. Short queries use a lower semantic cutoff. If semantic retrieval has no confident match, typo-tolerant lexical matching is used and each result is labeled `keyword_fallback`; this is never reported as semantic retrieval. Empty and unrelated queries can return no evidence. This is a genuine local vector index with a linear scan, not an ANN/vector-database service. Re-run `npm.cmd run rag:index` after policy text/version, model, or chunk settings change, then restart ResolveAI.

Transformers.js is an optional backend dependency so the base demo still starts without it. Local embeddings do not need an OpenAI or Gemini key. Settings and `/api/health` show index status, and each search/investigation response indicates the retrieval mode actually used. If indexing or model inference fails, the backend logs the reason and labels the result as keyword fallback; it never claims semantic retrieval in that path.

Optional settings in `server/.env`:

```dotenv
RAG_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
RAG_INDEX_PATH=
RAG_TOP_K=4
RAG_MIN_SCORE=0.18
RAG_CHUNK_SIZE=480
RAG_CHUNK_OVERLAP=80
RAG_REQUEST_TIMEOUT_MS=120000
```

Leave `RAG_INDEX_PATH` blank to use the default ignored index file. A custom path must be writable. Tune `RAG_MIN_SCORE` against evaluation examples before relying on it.

After installing the dependency and downloading the model, an opt-in test runs a real embedding smoke check:

```powershell
$env:RESOLVEAI_TEST_REAL_EMBEDDINGS = "1"
npm.cmd test
Remove-Item Env:RESOLVEAI_TEST_REAL_EMBEDDINGS
```

The normal automated tests cover policy ingestion, version selection, chunk identifiers and hashes, short queries, paraphrases across all active policy categories, typo fallback, unrelated/empty queries, citation validation, API integration, and refund safeguards. Real local-model tests are skipped unless enabled with the environment variable above. Citation validator unit tests do not verify a live OpenAI response; configure a backend API key only if you want to exercise generated explanations.

To check the key short-query path after the real model and index are ready, search the policy library for `broken headphones photo`. The result should include `physical-returns`, version `2.0`, and a citation ID equal to its canonical chunk ID. Investigation evidence cards show the exact excerpt and source metadata, and state whether AI citations were validated or the model text was rejected.

## Commands

Run these from `D:\resolveai` in PowerShell. Use `npm.cmd` if PowerShell blocks the `npm.ps1` shim under your execution policy; no policy change is needed.

| Command | Purpose |
| --- | --- |
| `npm.cmd install` | Install workspace dependencies |
| `npm.cmd run dev` | Compile the backend, then start one backend and one frontend process |
| `npm.cmd run typecheck` | Type-check server and client |
| `npm.cmd run lint` | Run ESLint on frontend, backend, and tests |
| `npm.cmd test` | Run the backend unit and HTTP integration tests |
| `npm.cmd run build` | Create production bundles for both apps |
| `npm.cmd run seed` | Seed configured MongoDB collections without deleting data |
| `npm.cmd run start --workspace server` | Run the compiled server and serve `client/dist` when it exists |

The development server uses port **4000** for the API and **5173** for Vite. The Vite proxy targets `http://127.0.0.1:4000`. To use a different backend port, set `PORT` in `server/.env` and `API_PROXY_TARGET` in `client/.env` to the matching URL.

The backend is compiled once when the development command starts and runs as a single process. The root runner checks that its ports are available, launches the frontend and backend directly, and stops the other service if either fails. It never terminates processes it did not start. This keeps demo cases in the shared in-memory store for the lifetime of the server. After changing backend TypeScript files, stop the servers with **Ctrl+C** and run `npm.cmd run dev` again to rebuild and restart cleanly.

For a local production-style run, build first, set private tokens in `server/.env`, and then run:

```powershell
npm.cmd run build
$env:NODE_ENV = "production"
npm.cmd start
```

The built frontend and API are then available together at **http://127.0.0.1:4000**. Production mode refuses to start unless both agent and administrator tokens are configured. This provides a local secure-token setup for evaluation; it does not replace a full identity provider for a public deployment.

## Folder structure

```text
client/
  src/App.tsx                 Responsive React workspace and pages
  src/styles.css              Dark emerald theme
  .env.example                Optional Vite-to-API proxy setting
server/
  src/app.ts                  Express routes, validation, auth, and audit
  src/services/               Deterministic investigation business rules
  policies/                   Versioned synthetic Markdown source documents
  src/knowledge/rag.ts        Ingestion, chunking, vector index, retrieval
  src/knowledge/policies.ts   API projection of active policies
  src/models/                 Mongoose record models
  src/database.ts             MongoDB connection and memory demo store
  src/seed.ts                 Sample customers, orders, policies, and cases
  tests/                      Node built-in unit and HTTP integration tests
  .resolveai/                 Generated vector index (ignored by Git)
package.json                  Windows-friendly workspace commands
```

## Pages

The sidebar links open the dashboard, support inbox/case details, customers, orders, policy library, human-review queue, analytics, and settings. The welcome page introduces the product. Dashboard and analytics values come from API data, including seeded records; the demo seed is illustrative rather than live customer information.

## Troubleshooting

- **PowerShell says scripts are disabled:** use `npm.cmd` commands as shown. Do not change the system execution policy just to run this app.
- **Port 4000 is already in use:** another process is listening there. Find and close the terminal that owns your ResolveAI server, or stop the process you recognize. ResolveAI never kills an unrelated process. The backend prints a clear `EADDRINUSE` message.
- **Port 5173 is already in use:** Vite uses strict port mode and exits with a clear error. Close the other Vite terminal or change its port and update your browser URL.
- **Settings show in-memory:** `MONGODB_URI` is blank, MongoDB is stopped, or the URI is invalid. Memory mode resets when the server stops.
- **Policy search says keyword fallback:** run `npm.cmd install @huggingface/transformers --workspace server`, then `npm.cmd run rag:index`; verify the vector index is ready in Settings and restart the server.
- **RAG indexing reports a model download error:** check internet access and free disk space, then rerun `npm.cmd run rag:index`. Keyword fallback remains available until indexing succeeds.
- **Settings show demo AI:** `OPENAI_API_KEY` is blank. This is expected and the local rule-based workflow remains available without an API subscription.
- **An admin action returns 403:** switch to the administrator demo role or supply the configured private administrator token in Settings.
- **The frontend cannot reach the API:** keep both services running in the `npm.cmd run dev` terminal and confirm the backend is on port 4000.

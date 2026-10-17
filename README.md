# Threads Story Studio

AI storytelling and publishing for Threads — from a topic, a personal experience or a Shopee product link to a published Threads story, with minimal manual work.

- **Mobile app** (iOS + Android, Expo SDK 57 / React Native 0.86, NativeWind) — create, edit, revise in chat, publish, track.
- **API** (Hono on Vercel, Postgres via Drizzle, better-auth) — AI orchestration, publishing engine, tracked links. All secrets live here.
- **Shared package** — parameter catalogue, Zod schemas, Threads length rules, used by both.

Everything runs from the app: there is no scheduler, queue or external automation server. When a story is finished, **Publish** sends it to Threads immediately.

> Stories are optimized for strong hooks, readability and relatability. Nothing here guarantees virality, and the AI is instructed never to invent personal experiences, product claims, reviews, discounts or urgency.

---

## Contents

1. [Architecture](#architecture)
2. [Quick start (local)](#quick-start-local)
3. [Environment variables](#environment-variables)
4. [Integrations](#integrations) — AI, Threads, Buffer, Shopee, push
5. [How publishing works](#how-publishing-works)
6. [Deployment](#deployment)
7. [Testing](#testing)
8. [Security model](#security-model)
9. [Integration status](#integration-status)

---

## Architecture

```
apps/
  api/        Hono API (Vercel). src/
    ai/          provider adapters (gemini, omniroute), orchestrator, versioned prompts, schemas
    stories/     story workflow, parameter engine usage, versions, revision chat
    products/    Shopee URL safety, extraction chain, Affiliate Open API, tracked links
    publishing/  provider interface, Threads + Buffer adapters, OAuth, publish service
    jobs/        durable publish steps (claim/lease/retry/reconcile) + background driver
    notifications/ (Expo push), analytics/, security/, routes/
  mobile/     Expo Router app. src/app = screens, src/components = UI kit + story components
packages/
  shared/     params catalogue + param engine, DTO schemas, statuses, Threads length rules
```

**Request path:** screen → TanStack Query → typed `api()` client (session cookie from SecureStore) → Hono route (`requireUser` → Zod validation) → service → Drizzle / provider adapter.

**Data model** (`apps/api/src/db/schema/app.ts`): every row is owned by a `user_id`, so multi-user later needs no rewrite. Original input, AI analyses, parameter configs (`ai_suggested | user_customized | locked | default`), variations, immutable versions, revision-chat messages, publications (unique idempotency keys), publish jobs and attempts, products, tracked links, analytics events and devices are separate tables.

### Story workflow

1. **Input** — topic/experience (Story) or Shopee link → product (Affiliate). Text or links shared from other apps land here via the share sheet.
2. **Analysis** — AI separates *facts you stated* from *missing details that won't be invented*, and may ask clarifying questions.
3. **Settings** — AI suggests every storytelling setting with a reason and confidence. Edit, lock, re-suggest (never overwrites locked or edited values) or reset to AI.
4. **Variations** — N (default 3) genuinely different strategies.
5. **Editor** — inline editing, reorder/add/remove posts, Threads-accurate character counter (emoji = UTF-8 bytes), quick AI improvements, selected-text rewrite, **revision chat** ("bikin hook-nya lebih nendang"), fact check. Every change is a new version; restore any version.
6. **Publish now** — exact preview (CTA + tracked link appended for affiliate stories), then straight to Threads (direct) or Buffer.

---

## Quick start (local)

Prerequisites: Node 22+, npm 10+, PostgreSQL 15+, and Android Studio (emulator) or Xcode **26.4+** (Expo SDK 57 requirement) — or EAS Build.

```bash
npm install                                   # all workspaces

createdb threads_story_studio
createdb threads_story_studio_test            # for the API test suite
cp apps/api/.env.example apps/api/.env        # fill in secrets (see below)
npm run db:migrate

npm run dev:api                               # API on http://localhost:3000
```

Mobile needs a **development build** (Expo Go can't load the share extension, notifications or biometrics):

```bash
cd apps/mobile
# Android emulator reaches the host at 10.0.2.2; a physical device needs your LAN IP or the deployed API
echo "EXPO_PUBLIC_API_URL=http://10.0.2.2:3000" > .env
npx expo run:android          # or: npx expo run:ios (Xcode 26.4+), or: npx eas-cli build --profile development
```

The first account you create becomes the owner; sign-up then closes (`ALLOW_SIGNUP=true` to reopen).

---

## Environment variables

All server configuration is in [`apps/api/.env.example`](apps/api/.env.example):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres (Neon **pooled** URL on Vercel) |
| `BETTER_AUTH_SECRET` | yes | Session signing (`openssl rand -base64 48`) |
| `ENCRYPTION_KEY` | yes | AES-256-GCM key for stored Threads tokens (`openssl rand -base64 32`) |
| `API_BASE_URL` | yes | Public API URL — OAuth callback and tracked links (https in prod) |
| `CRON_SECRET` | recommended | Authorizes the daily maintenance cron |
| `OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`, `OMNIROUTE_MODEL` | one AI provider | OmniRoute (OpenAI-compatible) |
| `GEMINI_API_KEY` (+ `GEMINI_MODEL`, `GEMINI_MODEL_LITE`) | one AI provider | Gemini API |
| `AI_PROVIDER_PRIORITY` | no | Default order, e.g. `omniroute,gemini` |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | Threads direct | Meta app credentials |
| `BUFFER_API_KEY` | Buffer | Personal API key |
| `SHOPEE_AFFILIATE_APP_ID`, `SHOPEE_AFFILIATE_SECRET` | no | Affiliate Open API |

Mobile: only `EXPO_PUBLIC_API_URL` (public by design — never put secrets in `EXPO_PUBLIC_*`). For push notifications set `expo.extra.eas.projectId` in `apps/mobile/app.json` (`npx eas-cli init`).

---

## Integrations

### AI providers (OmniRoute + Gemini)

- One interface (`AIProvider.complete`) behind an orchestrator: per-task provider choice (More › AI providers), fallback on quota/rate-limit/outage, bounded retries with backoff and `Retry-After`, timeouts, a request gate for OmniRoute, cache for analysis/suggestions, a per-user daily request limit, and usage logging (provider, model, task, tokens, latency, error — never prompt text).
- **OmniRoute** — OpenAI-compatible `/v1/chat/completions`. Combos reject `response_format`, so JSON is requested in the prompt, salvaged and validated with Zod; SSE replies are collapsed.
- **Gemini** — REST `v1beta/models/{model}:generateContent` with native JSON schema (`responseMimeType` + `responseSchema`).
- Every AI output is Zod-validated; one controlled repair turn on failure; malformed output becomes a typed error, never a crash.
- Prompts are versioned (`apps/api/src/ai/prompts/v1.ts`). Try them live: `cd apps/api && npx tsx --env-file=.env scripts/prompt-lab.ts general [gemini|omniroute]` (uses real quota).

### Threads (direct, official API)

1. Create a Meta app with the **Threads API** use case and permissions `threads_basic`, `threads_content_publish` (optionally `threads_manage_insights` with `THREADS_REQUEST_INSIGHTS=true`).
2. Add the redirect URI `${API_BASE_URL}/api/threads/oauth/callback`. Meta requires **https**, so connect through the deployed API (or an https tunnel).
3. While the Meta app is in development, add your Threads account as a tester. Publishing for other accounts needs Meta app review.
4. In the app: More › Publishing accounts › Connect Threads. The OAuth state is single-use, hashed and bound to your user; the code is exchanged for a 60-day token, encrypted at rest and refreshed automatically by the daily maintenance job.

### Buffer

Personal API key (`https://publish.buffer.com/settings/api`) → More › Publishing accounts › Choose Buffer channel (Threads channels only). Uses the GraphQL API: `createPost` with `mode: shareNow` and `metadata.threads.thread` for multi-post threads. Buffer only confirms that it **received** the post: it shows *Sent to Buffer* until Buffer reports it as *sent* (“Published — reported by Buffer”).

> `shareNow` is described in Buffer's docs prose; no literal example is published. If your account rejects it, the error is shown on the post.

### Shopee products & affiliate links

- Links are validated against Shopee hosts; short links are resolved hop-by-hop and every hop must stay on Shopee (SSRF-safe).
- Extraction: Shopee Affiliate Open API (if configured) → public page metadata (one honest request, no anti-bot bypass) → **manual entry** (the link is always kept). Fields you edit lose their "From Shopee" mark; the AI only uses confirmed data and never states a price you didn't confirm.
- Affiliate links you paste are stored **byte-for-byte**. Only links generated by the Affiliate API are labelled *verified affiliate*.
- Tracked redirect `GET /r/:slug` re-validates the stored destination (no URL parameter → no open redirect), records a click (bots excluded, IP salted+hashed) and 302s to the exact URL. Counts are **redirect clicks, not sales**.

### Push notifications, share sheet, app lock

- Push via the Expo push service: published, failed, Threads disconnected. Requires a physical device and an EAS project id. Invalid tokens are pruned from push receipts.
- Share a Shopee link to the app → Affiliate flow; share text or other links → Story flow.
- App lock (Face ID / fingerprint, device passcode fallback) — off by default; enabling requires a successful authentication.

---

## How publishing works

Tapping **Publish now** creates a publication (unique idempotency key — double taps return the same post) and a durable job, then the API finishes the job **in the background of that same request** (Vercel `waitUntil`, within the default 300-second function limit on every plan). No scheduler or external service is involved.

- **Threads direct:** create container → wait until Threads reports it ready (seconds for text) → publish → next post as a reply (`reply_to_id`) → fetch permalink. A lost response is **reconciled** (container status / recent posts) instead of re-sent, so a timeout can't double-post. Transient errors retry with backoff (3 attempts); permanent and auth errors fail immediately.
- **Buffer:** `createPost` (share now) → *Sent to Buffer* → status checks until Buffer reports *sent*.
- If anything is left unfinished (e.g. the server restarted mid-way), the app asks the server to continue whenever it comes to the foreground or while a post is open, and a **daily** Vercel cron (`/api/cron/tick`, Hobby-compatible) also finishes leftovers, refreshes Threads tokens and prunes old data.
- **Try again** on a failed post continues from saved progress — already-published posts of a thread are never re-sent.

---

## Deployment

### API → Vercel

1. Create a Postgres database (Vercel Marketplace → Neon). Use the **pooled** connection string as `DATABASE_URL`.
2. New Vercel project from this repo with **Root Directory** `apps/api` (Hono is detected automatically; `src/index.ts` exports the app).
3. Add the environment variables from `.env.example`; set `API_BASE_URL` to the deployment URL.
4. Run migrations against production: `DATABASE_URL=… npm run db:migrate` (from `apps/api`).
5. `apps/api/vercel.json` registers the daily maintenance cron (`0 3 * * *`), which works on the Hobby plan.

### Mobile → EAS

```bash
cd apps/mobile
npx eas-cli init                         # sets extra.eas.projectId (needed for push)
npx eas-cli build --profile development  # dev client (internal distribution)
npx eas-cli build --profile production   # store builds
```

Set `EXPO_PUBLIC_API_URL` per build profile in `eas.json`. iOS builds need an Apple developer account (the share extension adds a target that EAS signs automatically).

---

## Testing

```bash
npm run typecheck        # all workspaces
npm run lint             # Biome
npm test                 # shared (vitest) + api (vitest, real Postgres test DB) + mobile (jest-expo)
cd apps/mobile && npx expo-doctor && npx expo export --platform ios --platform android
```

- **API tests** use a real Postgres (`threads_story_studio_test`, override with `DATABASE_URL_TEST`) and **mocked** HTTP for OmniRoute/Gemini/Threads/Buffer/Shopee/Meta OAuth. Passing them does **not** prove the live integrations.
- Covered: JSON salvage, retry bounds, schema repair, provider fallback, caching, factuality prompt rules, suggestion sanitizing, parameter locks, Shopee URL/redirect safety, extraction fallback, byte-exact affiliate URLs, click tracking, Threads reply chains, idempotency (double tap, concurrent claims and drivers), lease recovery, unknown-outcome reconciliation, retry/permanent failure, auth expiry, time-budget handoff, Buffer mapping/sync, OAuth state + token exchange/refresh, unauthenticated access, secret leakage, invalid payloads.
- **Mobile tests**: settings panel (badges, edit, lock, re-suggest, reset), post editor (edit, reorder, delete, Threads counter), share-intake routing, biometric lock logic.

---

## Security model

- better-auth sessions; on mobile the session cookie lives in the Keychain/Keystore (SecureStore). Every non-public route uses `requireUser`; every query is scoped by `user_id`.
- Secrets only in server env; settings endpoints return booleans, never values. Threads tokens are AES-256-GCM encrypted. Logs are structured and redact tokens/keys/codes; prompt text is never logged.
- Postgres-backed rate limits (sign-in, sign-up, AI, imports, OAuth, publishing). OAuth state hashed, single-use, 10-minute expiry. No open redirects. SSRF-safe Shopee resolution. Errors are normalized (`{ error: { code, message } }`), never stack traces.

---

## Integration status

| Integration | Implemented | Automated tests | Live-verified |
|---|---|---|---|
| OmniRoute | ✅ | mocked | ✅ local instance (`vour-combos`), full story + revision chat flow |
| Gemini | ✅ | mocked | ✅ `gemini-3.8-flash` structured output |
| Threads direct (OAuth + publish) | ✅ | mocked | ❌ needs Meta app + https callback + tester account |
| Buffer | ✅ | mocked | ❌ needs `BUFFER_API_KEY` + Threads channel |
| Shopee page metadata | ✅ | mocked | ✅ fallback path observed (Shopee served no metadata) |
| Shopee Affiliate Open API | ✅ (auth per a working community client; `productOfferV2` fields unverified) | mocked | ❌ needs approved app id/secret |
| Expo push | ✅ | logic only | ❌ needs physical device + EAS project id |
| Daily Vercel cron | ✅ | endpoint tested | ❌ not deployed |

Do not consider publishing verified end-to-end until a post has gone out through an authorized Threads or Buffer account.

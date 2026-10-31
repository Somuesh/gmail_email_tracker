# Gmail Mail Tracker – standalone Gmail add-on

No Google Sheet. Two parts:

- `addon/` – Apps Script Gmail add-on (compose button + dashboard sidebar)
- `backend/` – Node/Express on Cloud Run + Firestore (pixel, link redirects, API)

## 1. Deploy the backend
```bash
cd backend
gcloud config set project YOUR_PROJECT
gcloud services enable run.googleapis.com firestore.googleapis.com
gcloud firestore databases create --location=asia-south1   # once
gcloud run deploy mail-tracker --source . --region asia-south1 --allow-unauthenticated \
  --set-env-vars PUBLIC_BASE_URL=https://TEMP,ADDON_AUDIENCE=TEMP
```
Re-deploy after you know the real URL and OAuth client ID (step 2):
```bash
gcloud run services update mail-tracker --region asia-south1 \
  --set-env-vars PUBLIC_BASE_URL=https://mail-tracker-xxxx.a.run.app,ADDON_AUDIENCE=<OAUTH_CLIENT_ID>
```
Firestore needs a composite index for `emails`: owner ASC + createdAt DESC
(the first dashboard load logs a link to create it).

## 2. Create the add-on
1. script.google.com → New project → paste `Code.gs`; enable "Show appsscript.json" and paste the manifest.
2. Set `BACKEND_URL` in Code.gs and `urlFetchWhitelist` in the manifest to your Cloud Run URL.
3. Project Settings → switch to a standard Google Cloud project (the one used above). Its
   OAuth client ID (APIs & Services → Credentials, or the OAuth consent screen's web client) is `ADDON_AUDIENCE`.
4. Deploy → Test deployments → Install (Gmail Add-on) to try it in your own Gmail.

## 3. Ship to customers
- Google Workspace Marketplace SDK: enable it, set the Apps Script deployment ID, fill the store listing.
- OAuth consent screen must be verified (Gmail scopes → sensitive; expect review).
- Required: public privacy policy and terms (state the pixel/link tracking, what is stored, retention,
  and the "Delete all my data" button, which calls `DELETE /api/me`). Tell users to disclose tracking to recipients (GDPR/consent).
- Private distribution (just your domain): publish as "Private" for Workspace admins, no review needed.

## Known limits (be upfront with customers)
- Gmail/Apple Mail privacy proxies preload images, so "opens" can be inflated or unattributable
  (events are tagged `google-proxy` / `apple-or-proxy` / `direct`).
- Add-ons can't read or rewrite the draft body, so links are added via "Insert tracked link", not auto-rewritten.
- The recipient list is read from the draft metadata at the time of tracking.

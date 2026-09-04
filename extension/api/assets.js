// The product assets a document names — description images, result attachments (IIFE global
// `ApiAssets`): which URL gets a request at all, and which gets the session's JWT. Depends on ApiErrors.

/* global ApiErrors */

const ApiAssets = (() => {
  const { ApiError } = ApiErrors;

  // Bucket URLs the INSTANCE signed for us: off-instance, but named by it and not by document data.
  const signedAssets = new Set();

  // ---- product assets (description images, result attachments) -------------
  // #205: content URLs come both absolute (`<instance>/attachments/{uid}.png`) and ROOT-RELATIVE
  // (`/rails/active_storage/…`) — a relative one resolves against the INSTANCE, never the document.
  function assetUrl(raw, baseUrl) {
    const base = baseUrl ? `${baseUrl}/` : '';
    try { return new URL(String(raw), base || undefined).toString(); } catch { return ''; }
  }

  // The two reads that need the live session: api.js owns the config and the JWT and hands them in.
  function create({ baseUrl, jwt, jwtAvailable, login, jwtRequest, rawFetch, timeout }) {
    // #21: on a private bucket the server presigns only the first artifacts of a result and flags the
    // rest `needs_presign` — this mints the signed URL for one of those, on demand.
    async function presignArtifact(url) {
      const doc = await jwtRequest('/artifacts/presign', { method: 'POST', body: { url } });
      const signed = (doc && doc.url) || '';
      if (signed) signedAssets.add(signed); // the instance vouched for this host; fetchAsset checks here
      return signed;
    }

    // SECURITY: the JWT rides along ONLY for the configured instance — a presigned bucket link carries
    // its own signature. `instanceOnly` refuses off-instance URLs: authored markdown can plant a beacon.
    // On BY DEFAULT: a host named in server data — an avatar, an attachment — gets no request unless
    // the instance signed for it itself. What the instance's own storage does with a 302 is its call.
    async function fetchAsset(raw, { instanceOnly = true } = {}) {
      const base = baseUrl();
      const url = assetUrl(raw, base);
      if (!url) throw new ApiError('http', 0, 'Unresolvable asset URL');
      const ours = !!base && (url === base || url.startsWith(`${base}/`));
      const allowed = ours || signedAssets.has(url);
      if (instanceOnly && !allowed) throw new ApiError('http', 0, 'Off-instance asset refused');
      const doGet = () => rawFetch(url, {
        credentials: 'omit',
        headers: ours && jwt() ? { Authorization: `Bearer ${jwt()}` } : undefined,
        timeout, // the asset itself, same size as the upload that made it
      });
      // Basic mode (no session) still tries: a signed bucket link needs no login at all.
      if (ours && !jwt() && jwtAvailable() !== false) await login().catch(() => {});
      let res = await doGet();
      if (ours && jwt() && (res.status === 401 || res.status === 403)) {
        await login().catch(() => {});
        res = await doGet();
      }
      return res;
    }

    return { assetUrl: (raw) => assetUrl(raw, baseUrl()), fetchAsset, presignArtifact };
  }

  return { signedAssets, assetUrl, create };
})();

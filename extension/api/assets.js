/* global ApiErrors */

const ApiAssets = (() => {
  const { ApiError } = ApiErrors;

  // Bucket URLs the instance signed for us: off-instance, but named by it, not by document data.
  const signedAssets = new Set();

  // URLs come absolute or root-relative; a relative one resolves against the instance, not the doc.
  function assetUrl(raw, baseUrl) {
    const base = baseUrl ? `${baseUrl}/` : '';
    try { return new URL(String(raw), base || undefined).toString(); } catch { return ''; }
  }

  function create({ baseUrl, jwt, jwtAvailable, login, jwtRequest, rawFetch, timeout }) {
    // A private bucket presigns only a result's first artifacts and flags the rest `needs_presign`.
    async function presignArtifact(url) {
      const doc = await jwtRequest('/artifacts/presign', { method: 'POST', body: { url } });
      const signed = (doc && doc.url) || '';
      if (signed) signedAssets.add(signed); // the instance vouched for this host; fetchAsset checks here
      return signed;
    }

    // JWT only to the instance; off-instance URLs refused by default: markdown can plant a beacon.
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

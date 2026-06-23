/**
 * Cross-browser-safe blob download.
 *
 * Centralised because the naive `createObjectURL → a.download → click → revoke` pattern has two
 * real cross-browser failure modes that were copied across export call sites:
 *
 *  - iOS Safari (especially the installed standalone PWA) frequently ignores the `download`
 *    attribute and navigates the single web-view to the blob, tearing down the running app.
 *    Opening in a new context (`target=_blank`) lets the file render/save in Safari proper while
 *    the app stays put. On engines that DO honour `download`, `target` is ignored — no downside.
 *  - Safari and Firefox may not have finished reading the blob when `click()` returns, so an
 *    immediate `revokeObjectURL` can abort the save. The revoke is therefore deferred.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // 60s is far longer than any browser needs to begin the transfer; the URL is discarded right
  // after, so there is no lasting leak (some old inline call sites never revoked at all).
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Convenience for the common "serialise a string and download it as a file" case. */
export function downloadTextFile(content, filename, mime) {
  downloadBlob(new Blob([content], { type: mime }), filename);
}

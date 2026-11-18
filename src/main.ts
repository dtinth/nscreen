// Entry point: a URL with a #fragment is a display; without one, the landing page.
addEventListener('hashchange', () => location.reload())
if (location.hash.length > 1) {
  document.body.dataset.mode = 'display'
  void import('./display.ts')
} else {
  document.body.dataset.mode = 'landing'
  void import('./landing.ts')
}

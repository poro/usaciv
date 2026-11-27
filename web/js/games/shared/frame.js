// Framing helper for games: app.fitBounds() inside what the dock leaves visible, corrected for phones. There the dock is
// a bottom sheet, but app.visibleArea() assumes it starts at 45% of the height; this measures the real sheet and pads
// the bottom by the difference (as Which Metro? does).
export function fitVisible(app, dockBody, x0, y0, x1, y1, opts = {}) {
  if (!app.fitBounds) return;
  let extra = 0;
  if (app.isMobile?.() && app.visibleArea) {
    const top = dockBody?.closest(".app-dock")?.getBoundingClientRect().top;
    if (top > 0 && top < innerHeight) extra = app.visibleArea().y1 - top;
  }
  app.fitBounds(x0, y0, x1, y1, { ...opts, padBottom: (opts.padBottom ?? 24) + extra });
}

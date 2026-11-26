// loadCss(ctx, href): add a stylesheet for the game; it is removed when the game exits.
// href is relative to web/ (e.g. "css/games/mainline.css") or absolute.
export function loadCss(ctx, href) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
  ctx.onCleanup(() => link.remove());
  return new Promise((res) => { link.onload = link.onerror = () => res(link); });
}

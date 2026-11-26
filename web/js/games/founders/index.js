// Placeholder: replaced by the real game. Contract: see games/host.js.
export function start(ctx) {
  const body = ctx.dock("left", { width: 340 });
  body.innerHTML = `<p>${ctx.game.title} is coming soon.</p>`;
  return {};
}

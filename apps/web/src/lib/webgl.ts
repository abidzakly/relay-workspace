/** three.js is WebGL2 only. Checked before a 3D chunk loads, so a browser without it never downloads the bundle. */
export function detectWebgl(): boolean {
  try {
    const context = document.createElement('canvas').getContext('webgl2');
    if (!context) return false;
    // Browsers limit live contexts, so give this probe's back at once.
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

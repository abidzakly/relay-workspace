import { z } from 'zod';

/**
 * The Figma MCP bridge (https://github.com/gethopp/figma-mcp-bridge) tools a Claude session may use, proxied through
 * Relay. The bridge runs on the Mac next to the Figma desktop app and acts as whoever is signed in there: an edit works
 * only in a file that account may edit, with the plugin open in the design editor (Dev Mode is read-only).
 *
 * Tools the bridge adds later are left out until Relay knows whether they write. Left out on purpose:
 * `save_screenshots`, `create_image` and `import_html_layers` (they read or write the bridge's local disk) and
 * `run_script` (arbitrary Plugin API code).
 */
export const FIGMA_READ_TOOLS = [
  'list_files',
  'get_document',
  'get_selection',
  'get_node',
  'get_prototype_connections',
  'trace_prototype_flow',
  'get_styles',
  'get_metadata',
  'get_design_context',
  'get_variable_defs',
  'get_screenshot',
  'get_motion_styles',
  'get_node_motion',
  // These move the viewport or the selection, never the document.
  'set_selection',
  'scroll_and_zoom_into_view',
] as const;

export const FIGMA_WRITE_TOOLS = [
  'set_reactions',
  'apply_animation_style',
  'remove_animation_style',
  'apply_manual_keyframe_track',
  'remove_manual_keyframe_track',
  'set_timeline_duration',
  'set_node_visibility',
  'set_text_content',
  'set_text_properties',
  'set_node_properties',
  'set_node_constraints',
  'apply_paint_style',
  'create_component_from_node',
  'combine_as_variants',
  'set_solid_fill',
  'set_gradient_fill',
  'set_effects',
  'set_stroke_properties',
  'set_auto_layout',
  'create_page',
  'create_frame',
  'create_section',
  'create_text',
  'create_shape',
  'create_shape_with_text',
  'create_svg',
  'create_sticky',
  'create_connector',
  'duplicate_nodes',
  'duplicate_with_offset',
  'fit_to_content',
  'distribute_horizontally',
  'distribute_vertically',
  'align_to_grid',
  'place_below',
  'place_right_of',
  'reparent_nodes',
  'group_nodes',
  'ungroup_node',
  'delete_nodes',
] as const;

/** Server name in the session's MCP config, so the tools are `mcp__figma_bridge__<tool>`. */
export const FIGMA_MCP_NAME = 'figma_bridge';

export function figmaToolIsWrite(name: string): boolean {
  return (FIGMA_WRITE_TOOLS as readonly string[]).includes(name);
}

/** Every bridge tool a session can ever get (the host agent refuses the rest). */
export const FIGMA_SESSION_TOOLS: readonly string[] = [...FIGMA_READ_TOOLS, ...FIGMA_WRITE_TOOLS];

/** What the host needs to give a Claude session the Figma tools: Relay's loopback address and the session's token. */
export const FigmaToolsProfileSchema = z
  .object({
    url: z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    write: z.boolean(),
  })
  .strict();
export type FigmaToolsProfile = z.infer<typeof FigmaToolsProfileSchema>;

/** Header the proxy MCP process sends with each call. */
export const FIGMA_SESSION_TOKEN_HEADER = 'x-figma-session-token';

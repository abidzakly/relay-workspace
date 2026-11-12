import { z } from 'zod';

/**
 * Postrack: an API workspace (endpoints, examples, mocks, environments) with an MCP server. Relay connects to it once
 * (OAuth or an API key) and hands its agents two things: the endpoints the user picked for a card, as files, and the
 * Postrack tools, proxied through Relay so the agent never holds a Postrack credential.
 */

/** Tools that only read. Always offered to an agent session with Postrack. */
export const POSTRACK_READ_TOOLS = [
  'list_workspaces',
  'get_workspace_tree',
  'list_endpoints',
  'get_endpoint',
  'list_folders',
  'list_environments',
  'get_environment',
] as const;

/**
 * Tools that change Postrack. Offered only when the session was started with "Agent may update Postrack", and even
 * then every call waits for the user's approval. Postrack has no delete tools.
 */
export const POSTRACK_WRITE_TOOLS = [
  'create_endpoint',
  'update_endpoint',
  'create_folder',
  'create_environment',
  'update_environment',
  'set_environment_variable',
] as const;

/** The MCP server name agents see: their tools are `mcp__postrack__<tool>`. */
export const POSTRACK_MCP_NAME = 'postrack';

export const postrackToolIsWrite = (name: string): boolean =>
  (POSTRACK_WRITE_TOOLS as readonly string[]).includes(name);

export const PostrackAuthModeSchema = z.enum(['oauth', 'apiKey']);
export type PostrackAuthMode = z.infer<typeof PostrackAuthModeSchema>;

/** `GET /api/postrack`. Never carries a secret. */
export const PostrackStatusSchema = z
  .object({
    /** The MCP endpoint (Streamable HTTP), e.g. `https://postrack.example.com/api/mcp/connect`. */
    url: z.string().nullable(),
    authMode: PostrackAuthModeSchema.nullable(),
    /** A call with the stored credentials worked (`list_workspaces`). */
    connected: z.boolean(),
    /** How many workspaces the account can reach, when connected. */
    workspaces: z.number().int().nonnegative().nullable(),
    /** Why it is not connected, for the user. */
    error: z.string().nullable(),
  })
  .strict();
export type PostrackStatus = z.infer<typeof PostrackStatusSchema>;

const PostrackUrlSchema = z.url({ protocol: /^https?$/ }).max(500);

/** `PUT /api/postrack`: save the URL and, for API-key mode, the key (`null` clears it, the mask keeps it). */
export const PostrackSaveSchema = z
  .object({
    url: PostrackUrlSchema,
    apiKey: z.string().trim().min(1).max(4_000).nullable().optional(),
  })
  .strict();
export type PostrackSave = z.infer<typeof PostrackSaveSchema>;

/** `POST /api/postrack/oauth/start`. `origin` is the Relay address the browser uses: the callback goes back there. */
export const PostrackOAuthStartSchema = z
  .object({
    url: PostrackUrlSchema,
    origin: z.url({ protocol: /^https?$/ }).max(300),
  })
  .strict();

export const PostrackOAuthStartResultSchema = z.object({
  /** Open this in a popup. Null when the stored tokens already work (nothing to sign in to). */
  authorizationUrl: z.string().nullable(),
});

const IdSchema = z.string().min(1).max(200);

export const PostrackWorkspaceSchema = z.object({ id: IdSchema, name: z.string() });
export type PostrackWorkspace = z.infer<typeof PostrackWorkspaceSchema>;

export const PostrackEndpointRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
  method: z.string(),
  url: z.string(),
});
export type PostrackEndpointRef = z.infer<typeof PostrackEndpointRefSchema>;

export interface PostrackFolderNode {
  id: string;
  name: string;
  folders: PostrackFolderNode[];
  endpoints: PostrackEndpointRef[];
}

export const PostrackFolderNodeSchema: z.ZodType<PostrackFolderNode> = z.lazy(() =>
  z.object({
    id: IdSchema,
    name: z.string(),
    folders: z.array(PostrackFolderNodeSchema),
    endpoints: z.array(PostrackEndpointRefSchema),
  }),
);

/** A workspace's projects → collections → folders → endpoints, as the picker shows it. */
export const PostrackTreeSchema = z.object({
  workspaceId: IdSchema,
  projects: z.array(
    z.object({
      id: IdSchema,
      name: z.string(),
      collections: z.array(PostrackFolderNodeSchema),
    }),
  ),
});
export type PostrackTree = z.infer<typeof PostrackTreeSchema>;

export const POSTRACK_ENDPOINTS_MAX = 20;

/** What a card start (or a plain session) asks of Postrack. */
export const CardStartPostrackSchema = z
  .object({
    /** Endpoints to hand the agent as files. May be empty: the agent then only gets the tools. */
    endpointIds: z.array(IdSchema).max(POSTRACK_ENDPOINTS_MAX).default([]),
    /** The project the endpoints belong to: its environments are handed over too. */
    projectId: IdSchema.optional(),
    /** "Agent may update Postrack": offers the write tools (each call still asks the user). */
    write: z.boolean().default(false),
  })
  .strict();
export type CardStartPostrack = z.infer<typeof CardStartPostrackSchema>;
export type CardStartPostrackInput = z.input<typeof CardStartPostrackSchema>;

/**
 * What the host needs to give a Claude session the Postrack tools: Relay's own loopback address and the session's
 * token. No Postrack credential ever reaches the host or the agent.
 */
export const PostrackToolsProfileSchema = z
  .object({
    url: z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    write: z.boolean(),
  })
  .strict();
export type PostrackToolsProfile = z.infer<typeof PostrackToolsProfileSchema>;

/** Header the proxy MCP process sends with each call. */
export const POSTRACK_SESSION_TOKEN_HEADER = 'x-postrack-session-token';

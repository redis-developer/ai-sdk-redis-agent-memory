import { tool, type ToolSet } from "ai";
import type { AgentMemory } from "@redis-iris/agent-memory";
import type { Namespace } from "@redis-iris/agent-memory/models";
import { z } from "zod";
import { IrisToolError } from "./errors.js";

export interface NamespaceToolOptions {
  ownerId?: string;
  namespaceId?: string;
  allowDeletes: boolean;
  assertMemory: (id: string, signal?: AbortSignal) => Promise<unknown>;
}

const identifier = z.string().min(1);
const scopeSchema = z.enum(["PERSONAL", "SHARED"]);
const namespaceName = z.string().min(1).refine((name) => !name.includes("/"), {
  message: "A namespace name is one path segment; use path to create a hierarchy.",
});

/** Optional namespace administration tools. Access checks never trust model-supplied IDs. */
export function createNamespaceTools(
  client: AgentMemory,
  options: NamespaceToolOptions,
): ToolSet {
  const requestOptions = (signal?: AbortSignal) => ({ signal });

  function assertNamespaceId(namespaceId: string): void {
    if (options.namespaceId !== undefined && namespaceId !== options.namespaceId) {
      throw new IrisToolError("INVALID_SCOPE", "This toolset is restricted to its configured namespace.");
    }
  }

  async function assertOwner(namespace: Namespace, signal?: AbortSignal): Promise<void> {
    if (options.ownerId === undefined) return;
    if (namespace.scope !== "PERSONAL") {
      throw new IrisToolError("INVALID_SCOPE", "This toolset can only access the configured owner's personal namespaces.");
    }
    const root = namespace.namespaceId === namespace.rootId
      ? namespace
      : (await client.getNamespace(namespace.rootId, requestOptions(signal))).namespace;
    if (root.scope !== "PERSONAL" || root.ownerId !== options.ownerId) {
      throw new IrisToolError("INVALID_SCOPE", "Namespace access is outside the configured owner scope.");
    }
  }

  async function assertNamespace(namespaceId: string, signal?: AbortSignal): Promise<Namespace> {
    assertNamespaceId(namespaceId);
    const result = await client.getNamespace(namespaceId, requestOptions(signal));
    await assertOwner(result.namespace, signal);
    return result.namespace;
  }

  const tools: ToolSet = {
    list_namespaces: tool({
      description:
        "List namespace roots or the direct children of a namespace. Reuse nextPageToken to fetch another page. " +
        "With a fixed namespace configuration, omit filters and pageToken to retrieve only that namespace.",
      inputSchema: z.object({
        parentId: identifier.optional().describe("List direct children; omit to list roots."),
        scope: scopeSchema.optional().describe("Root scope. Cannot be combined with parentId."),
        ownerId: identifier.optional().describe("Owner of PERSONAL roots. Cannot be combined with parentId."),
        limit: z.number().int().min(1).max(1000).optional(),
        pageToken: z.string().min(1).optional(),
      }),
      execute: async (input, { abortSignal }) => {
        if (options.namespaceId !== undefined) {
          if (input.parentId !== undefined || input.scope !== undefined || input.ownerId !== undefined || input.pageToken !== undefined) {
            throw new IrisToolError("INVALID_SCOPE", "Omit filters and pageToken when listing a fixed namespace.");
          }
          return { items: [await assertNamespace(options.namespaceId, abortSignal)] };
        }
        if (input.parentId !== undefined && (input.scope !== undefined || input.ownerId !== undefined)) {
          throw new IrisToolError("INVALID_SCOPE", "parentId cannot be combined with scope or ownerId.");
        }
        if (input.scope === "SHARED" && input.ownerId !== undefined) {
          throw new IrisToolError("INVALID_SCOPE", "ownerId only applies to PERSONAL namespaces.");
        }
        let scope = input.scope;
        let ownerId = input.ownerId;
        if (options.ownerId !== undefined) {
          if (scope === "SHARED" || (ownerId !== undefined && ownerId !== options.ownerId)) {
            throw new IrisToolError("INVALID_SCOPE", "Namespace filters conflict with the configured owner scope.");
          }
          if (input.parentId === undefined) {
            scope = "PERSONAL";
            ownerId = options.ownerId;
          }
        }
        if (input.parentId !== undefined) {
          await assertNamespace(input.parentId, abortSignal);
        } else if (ownerId !== undefined) {
          scope = "PERSONAL";
        }
        const result = await client.listNamespaces(
          input.parentId,
          scope,
          ownerId,
          input.limit,
          input.pageToken,
          requestOptions(abortSignal),
        );
        for (const namespace of result.items) await assertOwner(namespace, abortSignal);
        return result;
      },
    }),

    get_namespace: tool({
      description: "Retrieve a namespace's stable ID, current path, scope, owner, and archive state.",
      inputSchema: z.object({ namespaceId: identifier }),
      execute: async ({ namespaceId }, { abortSignal }) => ({
        namespace: await assertNamespace(namespaceId, abortSignal),
      }),
    }),

    create_namespace: tool({
      description:
        "Create a namespace root, a child, or an explicit hierarchy path. Use name with scope for a root, " +
        "name with parentId for a child, or path with scope for a hierarchy. PERSONAL roots require an owner. " +
        "Creation is unavailable when this toolset is bound to one fixed namespace.",
      inputSchema: z.object({
        name: namespaceName.optional(),
        path: z.string().min(1).optional(),
        scope: scopeSchema.optional(),
        parentId: identifier.optional(),
        ownerId: identifier.optional(),
      }),
      execute: async (input, { abortSignal }) => {
        if (options.namespaceId !== undefined) {
          throw new IrisToolError("INVALID_SCOPE", "Cannot create namespaces from a toolset bound to a fixed namespace.");
        }
        if ((input.name === undefined) === (input.path === undefined)) {
          throw new IrisToolError("INVALID_SCOPE", "Provide exactly one of name or path.");
        }
        if (input.parentId !== undefined) {
          if (input.path !== undefined || input.scope !== undefined || input.ownerId !== undefined) {
            throw new IrisToolError("INVALID_SCOPE", "Child creation requires name and parentId only.");
          }
          await assertNamespace(input.parentId, abortSignal);
          return client.createNamespace(
            { name: input.name, parentId: input.parentId },
            requestOptions(abortSignal),
          );
        }
        let scope = input.scope;
        let ownerId = input.ownerId;
        if (options.ownerId !== undefined) {
          if (scope === "SHARED" || (ownerId !== undefined && ownerId !== options.ownerId)) {
            throw new IrisToolError("INVALID_SCOPE", "Namespace creation conflicts with the configured owner scope.");
          }
          scope = "PERSONAL";
          ownerId = options.ownerId;
        }
        if (scope === undefined) throw new IrisToolError("INVALID_SCOPE", "Specify scope for a namespace root or hierarchy path.");
        if (scope === "PERSONAL" && ownerId === undefined) {
          throw new IrisToolError("INVALID_SCOPE", "PERSONAL namespaces require ownerId.");
        }
        if (scope === "SHARED" && ownerId !== undefined) {
          throw new IrisToolError("INVALID_SCOPE", "SHARED namespaces must omit ownerId.");
        }
        return client.createNamespace({ ...input, scope, ownerId }, requestOptions(abortSignal));
      },
    }),

    update_namespace: tool({
      description:
        "Rename a namespace or archive it. Archiving prevents new children and memory placements; " +
        "it does not delete the existing memories. Only archive on an explicit user request.",
      inputSchema: z.object({
        namespaceId: identifier,
        name: namespaceName.optional(),
        state: z.literal("ARCHIVED").optional(),
      }),
      execute: async ({ namespaceId, ...body }, { abortSignal }) => {
        if (body.name === undefined && body.state === undefined) {
          throw new IrisToolError("INVALID_SCOPE", "Provide a new name or state to update a namespace.");
        }
        await assertNamespace(namespaceId, abortSignal);
        return client.updateNamespace(namespaceId, body, requestOptions(abortSignal));
      },
    }),

    move_memories: tool({
      description:
        "Move existing long-term memories to an existing, active namespace. Supply known memory IDs and the " +
        "destination namespace ID. Partial failures are returned in errors; inspect them before claiming success.",
      inputSchema: z.object({
        memoryIds: z.array(identifier).min(1).max(100),
        namespaceId: identifier.describe("Destination namespace ID."),
      }),
      execute: async ({ memoryIds, namespaceId }, { abortSignal }) => {
        const namespace = await assertNamespace(namespaceId, abortSignal);
        if (namespace.state !== "ACTIVE") throw new IrisToolError("INVALID_SCOPE", "Cannot move memories into an archived namespace.");
        for (const memoryId of memoryIds) await options.assertMemory(memoryId, abortSignal);
        return client.moveLongTermMemories(
          { memoryIds, namespaceRef: { namespaceId } },
          requestOptions(abortSignal),
        );
      },
    }),
  };

  if (options.allowDeletes) {
    tools.delete_namespace = tool({
      description:
        "Delete an empty leaf namespace on the user's explicit request. The server rejects namespaces " +
        "that still contain children or memory placements. This does not recursively delete anything.",
      inputSchema: z.object({ namespaceId: identifier }),
      execute: async ({ namespaceId }, { abortSignal }) => {
        await assertNamespace(namespaceId, abortSignal);
        await client.deleteNamespace(namespaceId, requestOptions(abortSignal));
        return { deleted: true, namespaceId };
      },
    });
  }

  return tools;
}

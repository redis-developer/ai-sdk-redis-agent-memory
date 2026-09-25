/** Safe error details suitable for an AI SDK tool result. Never attach upstream bodies or headers. */
export class IrisToolError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode?: number) {
    super(message); this.name = 'IrisToolError';
  }
}

export const maxRpcJsonLineBytes = 64 * 1024 * 1024;

/** Local error identity distinguishes framing failures from untrusted runtime error records. */
export class RpcFrameTooLargeError extends Error {
  public constructor() {
    super(`Pi RPC emitted a JSON line larger than ${maxRpcJsonLineBytes / (1024 * 1024)} MiB.`);
    this.name = "RpcFrameTooLargeError";
  }
}

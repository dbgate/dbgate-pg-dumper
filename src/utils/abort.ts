/**
 * Shared cancellation helpers.
 *
 * Keeping abort checks consistent ensures every layer reports the platform's
 * standard `AbortError` semantics and avoids starting expensive work after a
 * caller has already cancelled the operation.
 */

/** Throws the signal's reason when cancellation has already been requested. */
export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

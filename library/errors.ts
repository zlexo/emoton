/**
 * A user-facing failure with the HTTP status the server should answer with:
 * 400 bad input, 404 unknown video / folder / source, 409 conflict, 422 validation.
 * Anything else (ffmpeg crashed, disk full) stays a plain Error: the server answers 500.
 */
export class LibraryError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422) {
    super(message);
    this.name = "LibraryError";
  }
}

export const badInput = (m: string) => new LibraryError(m, 400);
export const notFound = (m: string) => new LibraryError(m, 404);
export const conflict = (m: string) => new LibraryError(m, 409);
export const invalid = (m: string) => new LibraryError(m, 422);

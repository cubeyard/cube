/** The bounds and types of OptChat's attached images. Browser-safe (no Node
 * imports): the composer checks the same bounds before an upload. */

/** One image's bytes (its base64 stays under the 5 MB providers take), its
 * sides, the images of one message, of the messages waiting for a turn, the
 * images and their bytes in one turn's requests (whose base64 stays well
 * under Anthropic's 32 MB request), and the uploads not sent yet. */
export const MEDIA_LIMITS = { bytes: 3_750_000, side: 8000, perMessage: 4, waiting: 8, perTurn: 8, turnBytes: 15_000_000, unsent: 64 } as const;
export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type MediaType = typeof MEDIA_TYPES[number];
/** An image as a message carries it: its id in the chat's store. */
export type MediaRef = { id: string; mimeType: MediaType };

/**
 * The deliverable queue's row shapes — shared by the store (`server/store.ts`), the screens
 * (`src/data.ts`) and every template's demo seed (`templates/*.ts`). Plain types only.
 *
 * Dates are fixed ISO days so a seeded calendar renders the same month everywhere.
 */

export type PostStatus = "pending" | "ready" | "approved" | "posted" | "rejected";

export type PostChannel = "blog" | "linkedin" | "x" | "studio";

/** The channels a deliverable may be filed on, in the order the MCP tool lists them. */
export const POST_CHANNELS: readonly PostChannel[] = ["blog", "linkedin", "x", "studio"];

/** At most this many files on one deliverable: a mesh, a still, a STEP, an STL, a preview, a video — and room to spare. */
export const MAX_POST_FILES = 8;

/** A platform file id (`fil_…`) as `/v1/files/{id}` takes it; nothing else may sit in `files`. */
export const FILE_ID = /^fil_[A-Za-z0-9]+$/;

export interface Post {
  id: string;
  clientId: string;
  title: string;
  summary: string;
  /**
   * The draft itself — the piece the operator is approving. Optional because an agent may file a
   * placeholder before it has written anything, and a screen that invented a body for one of those
   * would be showing the operator work nobody did: the queue says so instead.
   */
  body?: string;
  /**
   * A kind id the active template declares (`templates/index.ts`) — `article`, `audit`, `post`, …
   * A string rather than a union because the kinds are template data: a row filed under one
   * template keeps its own kind after a switch, and the screens label an unrecognised one by its id
   * rather than dropping it.
   */
  kind: string;
  /**
   * Where the piece goes. `studio` is a `product-design` deliverable: a file the operator approves
   * and nothing else — approving or "posting" one never reaches a publisher (`server/routes.ts`).
   */
  channel: PostChannel;
  status: PostStatus;
  agent: string;
  /** ISO day (YYYY-MM-DD) the piece is slotted for on the calendar. */
  scheduledFor: string;
  postedAt?: string;
  rejectedReason?: string;
  /**
   * The platform files this deliverable IS (`fil_…` ids, at most `MAX_POST_FILES`): a concept mesh
   * and its still, a part's STEP + STL + preview. The Studio screen reads them through
   * `GET /api/files/:id`. Absent on every row that is only words.
   */
  files?: string[];
  clicks?: number;
  impressions?: number;
  hue: number;
}

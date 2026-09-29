import { z } from "zod";

// Placeholders that establish the schema-plus-type pattern; real fields come with the domain model.
export const Track = z.object({
  id: z.string(),
  title: z.string(),
});
export type Track = z.infer<typeof Track>;

export const Playlist = z.object({
  id: z.string(),
  name: z.string(),
});
export type Playlist = z.infer<typeof Playlist>;

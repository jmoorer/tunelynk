import { pgTable, text } from "drizzle-orm/pg-core";

// Placeholder so the first migration is real; replaced by the domain schema later.
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

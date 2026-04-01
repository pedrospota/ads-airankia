import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.ADS_DATABASE_URL,
});

export const adsDb = drizzle(pool, { schema });

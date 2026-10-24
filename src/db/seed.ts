import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";

import { createPropertySchema } from "../schemas/property";
import { properties } from "./schema";

const DATABASE_URL = process.env.DATABASE_URL ?? "sqlite.db";

const demoProperties = [
  {
    name: "Sunny Loft in Lisbon",
    city: "Lisbon",
    type: "apartment",
    status: "available",
    price: 320000,
    bedrooms: 2,
    bathrooms: 1,
    area: 78,
  },
  {
    name: "Riverside Family House",
    city: "Porto",
    type: "house",
    status: "available",
    price: 540000,
    bedrooms: 4,
    bathrooms: 3,
    area: 210,
  },
  {
    name: "Modern Studio in Berlin",
    city: "Berlin",
    type: "studio",
    status: "reserved",
    price: 185000,
    bedrooms: 1,
    bathrooms: 1,
    area: 42,
  },
  {
    name: "Historic Townhouse in Prague",
    city: "Prague",
    type: "townhouse",
    status: "available",
    price: 610000,
    bedrooms: 3,
    bathrooms: 2,
    area: 165,
  },
  {
    name: "Seaside Villa in Barcelona",
    city: "Barcelona",
    type: "villa",
    status: "sold",
    price: 1250000,
    bedrooms: 5,
    bathrooms: 4,
    area: 340,
  },
  {
    name: "Cozy Apartment in Vienna",
    city: "Vienna",
    type: "apartment",
    status: "available",
    price: 275000,
    bedrooms: 2,
    bathrooms: 1,
    area: 65,
  },
  {
    name: "Penthouse in Amsterdam",
    city: "Amsterdam",
    type: "penthouse",
    status: "reserved",
    price: 980000,
    bedrooms: 3,
    bathrooms: 2,
    area: 145,
  },
  {
    name: "Country Cottage near Dublin",
    city: "Dublin",
    type: "cottage",
    status: "available",
    price: 410000,
    bedrooms: 3,
    bathrooms: 2,
    area: 130,
  },
];

async function seed() {
  const sqlite = new Database(DATABASE_URL);
  const db = drizzle(sqlite);

  let inserted = 0;
  let skipped = 0;

  try {
    for (const candidate of demoProperties) {
      const parsed = createPropertySchema.safeParse(candidate);

      if (!parsed.success) {
        console.error(
          `Invalid demo property "${candidate.name}":`,
          parsed.error.flatten(),
        );
        continue;
      }

      const existing = await db
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.name, parsed.data.name))
        .limit(1);

      if (existing.length > 0) {
        console.log(`Skipped (already exists): ${parsed.data.name}`);
        skipped += 1;
        continue;
      }

      await db.insert(properties).values(parsed.data);
      console.log(`Inserted: ${parsed.data.name}`);
      inserted += 1;
    }

    console.log(`\nSeed complete: ${inserted} inserted, ${skipped} skipped.`);
  } finally {
    sqlite.close();
  }
}

seed().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const dbUrl = process.env.DATABASE_URL!;
if (!dbUrl.startsWith("file:")) {
  throw new Error("Only file-based SQLite URLs are supported (must start with 'file:').");
}

const adapter = new PrismaBetterSqlite3({ url: dbUrl });
const prisma = new PrismaClient({ adapter });

export { prisma }
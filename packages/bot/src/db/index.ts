import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from "@prisma/client";

if(!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set. Please set it to the path of your SQLite database, e.g. 'file:./prisma/dev.db'");
}

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
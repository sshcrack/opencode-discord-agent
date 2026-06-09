import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "./generated/client";

if(!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set. Please set it to the path of your SQLite database, e.g. 'file:./prisma/dev.db'");
}


const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL || "" });
export const prisma = new PrismaClient({ adapter });
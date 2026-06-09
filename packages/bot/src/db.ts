import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const dbUrl = process.env.DATABASE_URL!;
const isRemote = dbUrl.startsWith("http") || dbUrl.startsWith("libsql:");

const libsql = createClient({
  url: isRemote ? dbUrl : `file:${dbUrl.replace("file:", "")}`,
});

const adapter = new PrismaLibSQL(libsql as any);
export const prisma = new PrismaClient({ adapter });

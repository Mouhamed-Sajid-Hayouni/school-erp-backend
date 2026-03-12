import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // We are pasting the link directly here to bypass the Windows file error!
    url: "postgresql://neondb_owner:npg_4Uyb6jqaunRS@ep-orange-shape-alrgercn.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  },
});
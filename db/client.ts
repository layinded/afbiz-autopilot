import postgres from "postgres";

export type PgClient = postgres.Sql;

export function createDb(url: string): PgClient {
  return postgres(url, { max: 8, idle_timeout: 20, connect_timeout: 5 });
}

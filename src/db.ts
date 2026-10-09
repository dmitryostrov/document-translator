import postgres from "postgres";
import { config } from "./config";
export const sql = postgres(config.database, { max: 12, idle_timeout: 20, connect_timeout: 5, onnotice: () => {} });
export async function migrate() {
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(91783001)`;
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS owners (id text primary key, created_at timestamptz default now());
      CREATE TABLE IF NOT EXISTS groups (
        id uuid primary key, owner text not null, request_key text not null, fingerprint text not null,
        cap numeric(18,9) default 0, approved boolean default false, children jsonb default '[]',
        unique(owner,request_key));
      CREATE TABLE IF NOT EXISTS jobs (
        id uuid primary key, owner text not null, request_key text not null, fingerprint text not null,
        format text not null, target text not null, options jsonb not null, source_path text not null,
        source_hash text not null, stage text default 'PREFLIGHT', approved boolean default false,
        cap numeric(18,9) default 0, group_id uuid references groups(id), ir jsonb, quote jsonb,
        glossary jsonb default '{"entries":[]}', warnings jsonb default '[]', quality jsonb,
        artifact jsonb, error text, created_at timestamptz default now(), updated_at timestamptz default now(),
        deadline timestamptz default now()+interval '120 minutes', unique(owner,request_key));
      CREATE TABLE IF NOT EXISTS units (
        id uuid primary key, job_id uuid not null references jobs(id), kind text not null,
        sequence int default 0, payload jsonb default '{}', result jsonb, state text default 'READY',
        generation int default 0, lease_owner text, lease_expires_at timestamptz,
        not_before timestamptz default now(), ready_since timestamptz default now(),
        attempts int default 0, unique(job_id,kind,sequence));
      CREATE INDEX IF NOT EXISTS units_ready ON units(state,not_before,ready_since);
      CREATE TABLE IF NOT EXISTS calls (
        id text primary key, job_id uuid not null references jobs(id), unit_id uuid references units(id),
        kind text not null, state text default 'INTENT', reserved numeric(18,9) not null, cost numeric(18,9) default 0,
        usage jsonb, response jsonb, response_id text, input_hash text, created_at timestamptz default now(),
        updated_at timestamptz default now());
      CREATE TABLE IF NOT EXISTS starts (
        job_id uuid references jobs(id), request_key text, fingerprint text, primary key(job_id,request_key));
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS canonical_input_hash text;
      CREATE TABLE IF NOT EXISTS group_starts (
        group_id uuid references groups(id), request_key text, fingerprint text, primary key(group_id,request_key));
      CREATE TABLE IF NOT EXISTS artifacts (
        id uuid primary key, job_id uuid references jobs(id), path text not null, hash text not null,
        size bigint not null, renderer text not null, created_at timestamptz default now());
      CREATE TABLE IF NOT EXISTS cache (
        owner text, key text, value jsonb not null, primary key(owner,key));
      CREATE TABLE IF NOT EXISTS tool_events (
        job_id uuid references jobs(id), name text, block_ids jsonb, created_at timestamptz default now());
      CREATE TABLE IF NOT EXISTS fake_events (
        id bigserial primary key, call_id text not null, job_id uuid, kind text, state text, created_at timestamptz default now());
      CREATE TABLE IF NOT EXISTS test_gates (
        name text primary key, enabled boolean default true, hits int default 0);
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_count int default 0;
      CREATE INDEX IF NOT EXISTS calls_job ON calls(job_id);
      CREATE INDEX IF NOT EXISTS calls_unit ON calls(unit_id);
      CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner,created_at desc);
      CREATE INDEX IF NOT EXISTS units_job_state ON units(job_id,state);
    `);
  });
}

-- Starter metadata schema. Review/test policies before production use.
create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled project',
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  script text not null default '',
  output_key text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  asset_type text not null check (asset_type in ('video','audio','image')),
  object_key text not null,
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;
alter table public.jobs enable row level security;
alter table public.assets enable row level security;

drop policy if exists "Users manage their own projects" on public.projects;
create policy "Users manage their own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage their own jobs" on public.jobs;
create policy "Users manage their own jobs" on public.jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage their own assets" on public.assets;
create policy "Users manage their own assets" on public.assets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- LoveAi SaaS — run this in the Supabase SQL editor (one time).
-- Also configure (dashboard):
--   Auth → Providers → Google: enable, using a Google Cloud OAuth "Web application"
--     client whose authorized redirect URI is
--     https://<project-ref>.supabase.co/auth/v1/callback
--   Auth → URL Configuration → Additional Redirect URLs: add  loveai://auth-callback

-- ===== Tables =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  plan text not null default 'free',      -- future: 'pro' | ... (Stripe later)
  plan_expires_at timestamptz,            -- null = perpetual
  stripe_customer_id text,                -- reserved for billing
  created_at timestamptz default now()
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}',
  updated_at timestamptz default now()
);

create table public.user_roster (
  user_id uuid primary key references auth.users(id) on delete cascade,
  agents jsonb not null default '[]',
  updated_at timestamptz default now()
);

create table public.user_skills (
  user_id uuid primary key references auth.users(id) on delete cascade,
  skills jsonb not null default '{}',     -- { "skill-name": "SKILL.md content" }
  updated_at timestamptz default now()
);

-- ===== Row Level Security =====
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_roster enable row level security;
alter table public.user_skills enable row level security;

-- profiles: user can READ their own row only. No insert/update policy — the
-- trigger below creates it and plan changes happen via service role only.
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

create policy "own settings read" on public.user_settings
  for select using (auth.uid() = user_id);
create policy "own settings insert" on public.user_settings
  for insert with check (auth.uid() = user_id);
create policy "own settings update" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own roster read" on public.user_roster
  for select using (auth.uid() = user_id);
create policy "own roster insert" on public.user_roster
  for insert with check (auth.uid() = user_id);
create policy "own roster update" on public.user_roster
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own skills read" on public.user_skills
  for select using (auth.uid() = user_id);
create policy "own skills insert" on public.user_skills
  for insert with check (auth.uid() = user_id);
create policy "own skills update" on public.user_skills
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== Auto-create a profile on signup =====
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

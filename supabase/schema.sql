-- Second Read database. Paste this into Supabase → SQL Editor → New query → Run.
-- Only the site's server (using the secret key) can read or write these tables:
-- row level security is on and there are no public policies.

-- Training data for our own models.
create table if not exists samples (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  text        text not null,
  label       text check (label in ('human', 'ai')),   -- null = not labelled yet
  origin      text not null,                          -- 'public:<dataset>', 'student', 'generated'
  tool        text,                                   -- which tool it came from
  model_score int,                                    -- AI % our detector gave it (for review)
  user_hash   text,                                   -- one-way hash of the Google account, never the email
  text_hash   text unique,                            -- stops duplicates
  words       int
);
create index if not exists samples_label_idx on samples (label);

-- Thumbs up/down and "this was wrongly flagged" reports.
create table if not exists feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  tool        text not null,
  rating      text check (rating in ('up', 'down')),
  kind        text,                                   -- e.g. 'wrong_ai', 'correct_ai', 'good', 'bad'
  comment     text,
  score       int,
  user_hash   text,
  sample_id   bigint references samples (id) on delete set null
);

-- Our own plagiarism index: sources already found, looked up before searching the web.
create table if not exists sources (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  passage_hash text not null,                         -- one-way hash of the matched sentence (normalised)
  passage      text,                                  -- the sentence itself, only when the student agreed
  url          text not null,
  title        text,
  type         text check (type in ('book', 'web')),
  hits         int not null default 1,
  unique (passage_hash, url)
);
create index if not exists sources_hash_idx on sources (passage_hash);

-- Free-trial start time per student (one-way hash of the Google account).
create table if not exists trials (
  user_hash  text primary key,
  started_at timestamptz not null default now()
);

alter table samples  enable row level security;
alter table feedback enable row level security;
alter table sources  enable row level security;
alter table trials   enable row level security;

-- Quick overview: run "select * from training_stats;" any time.
create or replace view training_stats with (security_invoker = true) as
  select coalesce(label, 'unlabelled') as label, origin, count(*) as rows
  from samples group by 1, 2 order by 1, 2;
revoke all on training_stats from anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- Usage, cost and revenue for the owner's /stats page (added October 2026).
-- Safe to run again: everything uses "if not exists".

-- One row per tool request: which tool, words, Claude usage and its cost. Never the text.
create table if not exists events (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  tool        text not null,                          -- analyze, write, humanize, plagiarism, billing
  mode        text,                                   -- e.g. paraphrase style, review, cite, pro_signup
  status      int,                                    -- HTTP status (402 = hit the free word limit)
  user_hash   text,
  plan        text,                                   -- free, pro, owner
  words       int,
  in_tokens   int,
  out_tokens  int,
  searches    int,
  model       text,
  cost_usd    numeric(12, 6)
);
create index if not exists events_created_idx on events (created_at);

-- Which accounts used the site on which day (for daily / new users).
create table if not exists active_days (
  user_hash  text not null,
  day        date not null,
  plan       text,
  primary key (user_hash, day)
);

-- PayPal subscription IDs, so /stats can fetch the real payments from PayPal.
create table if not exists subscriptions (
  id          text primary key,
  user_hash   text,
  created_at  timestamptz not null default now()
);

alter table events        enable row level security;
alter table active_days   enable row level security;
alter table subscriptions enable row level security;

-- Normalize trends and projects into a true many-to-many relationship without losing legacy links.

alter table public.trends
  add column if not exists source_platform text not null default '待补充',
  add column if not exists discovered_on date,
  add column if not exists target_audience text not null default '待补充',
  add column if not exists signal_note text not null default '待补充',
  add column if not exists confidence text not null default '待评估';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'trends' and column_name = 'url'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'trends' and column_name = 'original_url'
  ) then
    alter table public.trends rename column url to original_url;
  end if;
end $$;

update public.trends
set discovered_on = coalesce(discovered_on, created_at::date),
    signal_note = case
      when signal_note = '待补充' and length(trim(coalesce(hypothesis, ''))) > 0 then hypothesis
      else signal_note
    end;

alter table public.trends alter column discovered_on set default current_date;
alter table public.trends alter column discovered_on set not null;

create table if not exists public.project_trends (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  trend_id uuid not null references public.trends(id) on delete cascade,
  hypothesis text not null default '待补充验证假设' check (length(trim(hypothesis)) > 0),
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, trend_id)
);

create index if not exists project_trends_project_id_idx on public.project_trends(project_id);
create index if not exists project_trends_trend_id_idx on public.project_trends(trend_id);

drop trigger if exists project_trends_set_updated_at on public.project_trends;
create trigger project_trends_set_updated_at before update on public.project_trends
for each row execute function public.set_updated_at();

-- Preserve the original trends.project_id relationship first.
insert into public.project_trends (project_id, trend_id, hypothesis, created_by, created_at)
select t.project_id, t.id, coalesce(nullif(trim(t.hypothesis), ''), '待补充验证假设'), 'legacy-migration', t.created_at
from public.trends t
join public.projects p on p.id = t.project_id
where t.project_id is not null
on conflict (project_id, trend_id) do nothing;

-- If a project only had a legacy name string, create a recoverable trend record when none exists.
insert into public.trends (
  name, original_url, growth, volume, hypothesis, status,
  source_platform, discovered_on, target_audience, signal_note, confidence
)
select legacy.name, '', '待录入', '待录入', '由历史项目趋势名称迁移', '等待趋势确认',
  '历史数据', current_date, '待补充', '由项目旧趋势字段自动恢复', '待评估'
from (
  select distinct trim(p.trend) as name
  from public.projects p
  where length(trim(coalesce(p.trend, ''))) > 0 and trim(p.trend) <> '待关联趋势'
) legacy
where not exists (select 1 from public.trends t where trim(t.name) = legacy.name);

-- Link all legacy project names to one canonical matching trend.
insert into public.project_trends (project_id, trend_id, hypothesis, created_by, created_at)
select p.id, matched.id, coalesce(nullif(trim(matched.hypothesis), ''), '待补充验证假设'), 'legacy-migration', p.created_at
from public.projects p
join lateral (
  select t.id, t.hypothesis
  from public.trends t
  where trim(t.name) = trim(p.trend)
  order by t.created_at, t.id
  limit 1
) matched on true
where length(trim(coalesce(p.trend, ''))) > 0 and trim(p.trend) <> '待关联趋势'
on conflict (project_id, trend_id) do nothing;

alter table public.project_trends enable row level security;

drop policy if exists "Public can read project trend relations" on public.project_trends;
create policy "Public can read project trend relations" on public.project_trends
for select using (
  exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null)
);

drop policy if exists "Admin manages project trend relations" on public.project_trends;
create policy "Admin manages project trend relations" on public.project_trends for all
using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());

-- Replace the legacy policy before removing trends.project_id.
drop policy if exists "Public can read trends" on public.trends;
create policy "Public can read linked trends" on public.trends
for select using (
  exists (
    select 1 from public.project_trends pt
    join public.projects p on p.id = pt.project_id
    where pt.trend_id = trends.id and p.deleted_at is null
  )
);

grant select on public.project_trends to anon, authenticated;
grant insert, update, delete on public.project_trends to authenticated;

create or replace function public.save_trend_with_projects(
  p_trend_id uuid,
  p_name text,
  p_source_platform text,
  p_original_url text,
  p_discovered_on date,
  p_volume text,
  p_growth text,
  p_target_audience text,
  p_signal_note text,
  p_confidence text,
  p_status text,
  p_links jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_trend_id uuid;
  v_actor text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_expected integer;
  v_valid integer;
begin
  if not public.is_dashboard_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) = 0 then
    raise exception 'TREND_PROJECT_REQUIRED';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(trim(coalesce(p_source_platform, ''))) = 0 or
    length(trim(coalesce(p_original_url, ''))) = 0 or p_discovered_on is null or
    length(trim(coalesce(p_volume, ''))) = 0 or length(trim(coalesce(p_growth, ''))) = 0 or
    length(trim(coalesce(p_target_audience, ''))) = 0 or length(trim(coalesce(p_signal_note, ''))) = 0 or
    length(trim(coalesce(p_confidence, ''))) = 0 or length(trim(coalesce(p_status, ''))) = 0 then
    raise exception 'TREND_FIELDS_INCOMPLETE';
  end if;

  select count(*), count(p.id) into v_expected, v_valid
  from jsonb_array_elements(p_links) link
  left join public.projects p on p.id = (link ->> 'project_id')::uuid and p.deleted_at is null
  where length(trim(coalesce(link ->> 'hypothesis', ''))) > 0;
  if v_expected <> jsonb_array_length(p_links) or v_valid <> v_expected then
    raise exception 'TREND_LINKS_INVALID';
  end if;

  if p_trend_id is null then
    insert into public.trends (
      name, source_platform, original_url, discovered_on, volume, growth,
      target_audience, signal_note, confidence, status
    ) values (
      trim(p_name), trim(p_source_platform), trim(p_original_url), p_discovered_on,
      trim(p_volume), trim(p_growth), trim(p_target_audience), trim(p_signal_note),
      trim(p_confidence), trim(p_status)
    ) returning id into v_trend_id;
  else
    update public.trends set
      name = trim(p_name), source_platform = trim(p_source_platform),
      original_url = trim(p_original_url), discovered_on = p_discovered_on,
      volume = trim(p_volume), growth = trim(p_growth),
      target_audience = trim(p_target_audience), signal_note = trim(p_signal_note),
      confidence = trim(p_confidence), status = trim(p_status)
    where id = p_trend_id returning id into v_trend_id;
    if v_trend_id is null then raise exception 'TREND_NOT_FOUND'; end if;
  end if;

  delete from public.project_trends pt
  where pt.trend_id = v_trend_id and not exists (
    select 1 from jsonb_array_elements(p_links) link
    where (link ->> 'project_id')::uuid = pt.project_id
  );

  insert into public.project_trends (project_id, trend_id, hypothesis, created_by)
  select (link ->> 'project_id')::uuid, v_trend_id, trim(link ->> 'hypothesis'), v_actor
  from jsonb_array_elements(p_links) link
  on conflict (project_id, trend_id) do update set hypothesis = excluded.hypothesis;

  return v_trend_id;
end;
$function$;

grant execute on function public.save_trend_with_projects(
  uuid, text, text, text, date, text, text, text, text, text, text, jsonb
) to authenticated;

alter table public.trends drop column if exists project_id;
alter table public.trends drop column if exists hypothesis;
alter table public.projects drop column if exists trend;

do $$
begin
  alter publication supabase_realtime add table public.project_trends;
exception when duplicate_object then null;
end $$;

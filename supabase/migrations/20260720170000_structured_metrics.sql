-- Structured metric definitions + multi-period observations.

alter table public.metrics
  add column if not exists unit text not null default '自定义',
  add column if not exists baseline_value numeric not null default 0,
  add column if not exists target_value numeric not null default 0,
  add column if not exists comparison_operator text not null default '>=' check (comparison_operator in ('>', '>=', '<', '<=')),
  add column if not exists stage smallint not null default 0 check (stage between 0 and 4),
  add column if not exists is_key boolean not null default false;

update public.metrics m set
  unit = case
    when m.value like '%\%%' then '%'
    when m.value like '%人%' then '人'
    when m.value ~ '(¥|￥|元)' then '元'
    when m.value like '%次%' then '次'
    when m.value like '%秒%' then '秒'
    when m.value like '%分钟%' then '分钟'
    else '自定义'
  end,
  baseline_value = coalesce(((regexp_match(m.value, '[-+]?[0-9]+(?:\.[0-9]+)?'))[1])::numeric, 0),
  target_value = coalesce(((regexp_match(m.value, '[-+]?[0-9]+(?:\.[0-9]+)?'))[1])::numeric, 0),
  stage = p.stage
from public.projects p
where p.id = m.project_id;

create table if not exists public.metric_observations (
  id uuid primary key default gen_random_uuid(),
  metric_id uuid not null references public.metrics(id) on delete cascade,
  value numeric not null,
  period_start date not null,
  period_end date not null,
  sample_size integer check (sample_size is null or sample_size >= 0),
  source_name text not null,
  source_url text not null default '',
  measured_at timestamptz not null default now(),
  methodology text not null default '',
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (metric_id, period_start, period_end),
  check (period_end >= period_start)
);

create index if not exists metric_observations_metric_id_idx
on public.metric_observations(metric_id, measured_at desc);

drop trigger if exists metric_observations_set_updated_at on public.metric_observations;
create trigger metric_observations_set_updated_at before update on public.metric_observations
for each row execute function public.set_updated_at();

insert into public.metric_observations (
  metric_id, value, period_start, period_end, sample_size,
  source_name, source_url, measured_at, methodology, created_by, created_at
)
select m.id, coalesce(((regexp_match(m.value, '[-+]?[0-9]+(?:\.[0-9]+)?'))[1])::numeric, 0), m.created_at::date, m.created_at::date, null,
  coalesce(nullif(trim(m.source), ''), '历史数据'), '', m.updated_at,
  concat_ws('；', nullif(trim(m.note), ''), '由旧文本指标兼容迁移，样本量待补充'),
  'legacy-migration', m.created_at
from public.metrics m
on conflict (metric_id, period_start, period_end) do nothing;

alter table public.metric_observations enable row level security;

drop policy if exists "Public can read active metric observations" on public.metric_observations;
create policy "Public can read active metric observations" on public.metric_observations
for select using (
  exists (
    select 1 from public.metrics m
    join public.projects p on p.id = m.project_id
    where m.id = metric_id and p.deleted_at is null
  )
);

drop policy if exists "Admin manages metric observations" on public.metric_observations;
create policy "Admin manages metric observations" on public.metric_observations for all
using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());

grant select on public.metric_observations to anon, authenticated;
grant insert, update, delete on public.metric_observations to authenticated;

create or replace function public.metric_status(p_metric_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_target numeric;
  v_baseline numeric;
  v_operator text;
  v_value numeric;
  v_sample integer;
  v_tolerance numeric;
begin
  select m.target_value, m.baseline_value, m.comparison_operator,
    o.value, o.sample_size
  into v_target, v_baseline, v_operator, v_value, v_sample
  from public.metrics m
  left join lateral (
    select value, sample_size
    from public.metric_observations
    where metric_id = m.id
    order by measured_at desc, period_end desc, created_at desc
    limit 1
  ) o on true
  where m.id = p_metric_id;

  if not found or v_value is null or coalesce(v_sample, 0) <= 0 then return '数据不足'; end if;
  if (v_operator = '>' and v_value > v_target) or
     (v_operator = '>=' and v_value >= v_target) or
     (v_operator = '<' and v_value < v_target) or
     (v_operator = '<=' and v_value <= v_target) then return '达标'; end if;

  v_tolerance := greatest(abs(v_target - v_baseline) * 0.2, abs(v_target) * 0.1, 0.0001);
  if (v_operator in ('>', '>=') and v_value >= v_target - v_tolerance) or
     (v_operator in ('<', '<=') and v_value <= v_target + v_tolerance) then return '接近目标'; end if;
  return '未达标';
end;
$$;

grant execute on function public.metric_status(uuid) to anon, authenticated;

create or replace function public.save_metric_with_observation(
  p_metric_id uuid,
  p_project_id uuid,
  p_name text,
  p_unit text,
  p_baseline_value numeric,
  p_target_value numeric,
  p_comparison_operator text,
  p_stage integer,
  p_is_key boolean,
  p_value numeric default null,
  p_period_start date default null,
  p_period_end date default null,
  p_sample_size integer default null,
  p_source_name text default null,
  p_source_url text default '',
  p_measured_at timestamptz default null,
  p_methodology text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metric_id uuid;
  v_actor text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not public.is_dashboard_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and deleted_at is null) then
    raise exception 'PROJECT_NOT_FOUND';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(trim(coalesce(p_unit, ''))) = 0 or
     p_baseline_value is null or p_target_value is null or
     p_comparison_operator not in ('>', '>=', '<', '<=') or p_stage < 0 or p_stage > 4 then
    raise exception 'METRIC_DEFINITION_INCOMPLETE';
  end if;

  if p_metric_id is null then
    insert into public.metrics (
      project_id, name, unit, baseline_value, target_value,
      comparison_operator, stage, is_key
    ) values (
      p_project_id, trim(p_name), trim(p_unit), p_baseline_value, p_target_value,
      p_comparison_operator, p_stage::smallint, coalesce(p_is_key, false)
    ) returning id into v_metric_id;
  else
    update public.metrics set
      name = trim(p_name), unit = trim(p_unit), baseline_value = p_baseline_value,
      target_value = p_target_value, comparison_operator = p_comparison_operator,
      stage = p_stage::smallint, is_key = coalesce(p_is_key, false)
    where id = p_metric_id and project_id = p_project_id returning id into v_metric_id;
    if v_metric_id is null then raise exception 'METRIC_NOT_FOUND'; end if;
  end if;

  if p_value is not null then
    if p_period_start is null or p_period_end is null or p_period_end < p_period_start or
       coalesce(p_sample_size, 0) <= 0 or length(trim(coalesce(p_source_name, ''))) = 0 or
       p_measured_at is null or length(trim(coalesce(p_methodology, ''))) = 0 then
      raise exception 'METRIC_OBSERVATION_INCOMPLETE';
    end if;
    insert into public.metric_observations (
      metric_id, value, period_start, period_end, sample_size,
      source_name, source_url, measured_at, methodology, created_by
    ) values (
      v_metric_id, p_value, p_period_start, p_period_end, p_sample_size,
      trim(p_source_name), trim(coalesce(p_source_url, '')), p_measured_at,
      trim(p_methodology), v_actor
    )
    on conflict (metric_id, period_start, period_end) do update set
      value = excluded.value, sample_size = excluded.sample_size,
      source_name = excluded.source_name, source_url = excluded.source_url,
      measured_at = excluded.measured_at, methodology = excluded.methodology,
      created_by = excluded.created_by;
  elsif p_metric_id is null then
    raise exception 'FIRST_OBSERVATION_REQUIRED';
  end if;
  return v_metric_id;
end;
$$;

grant execute on function public.save_metric_with_observation(
  uuid, uuid, text, text, numeric, numeric, text, integer, boolean,
  numeric, date, date, integer, text, text, timestamptz, text
) to authenticated;

alter table public.metrics drop column if exists value;
alter table public.metrics drop column if exists source;
alter table public.metrics drop column if exists note;

create or replace function public.change_project_stage(
  p_project_id uuid,
  p_target_stage integer,
  p_reason text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from smallint;
  v_name text;
  v_missing integer;
  v_metric_missing integer;
  v_type text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_actor text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not public.is_dashboard_admin() then raise exception 'ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_target_stage is null or p_target_stage < 0 or p_target_stage > 4 then raise exception 'INVALID_TARGET_STAGE'; end if;
  select stage, name into v_from, v_name from public.projects
  where id = p_project_id and deleted_at is null for update;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  if v_from = p_target_stage then raise exception 'STAGE_UNCHANGED'; end if;

  if p_target_stage > v_from then
    select count(*) into v_missing
    from public.stage_gate_definitions d
    left join public.project_stage_gates g
      on g.project_id = p_project_id and g.stage = d.stage and g.gate_key = d.gate_key and g.completed
    where d.stage = v_from and d.required and g.id is null;
    if v_missing > 0 then raise exception 'STAGE_GATES_INCOMPLETE:%', v_missing; end if;
    if not exists (
      select 1 from public.validation_experiments e
      where e.project_id = p_project_id and e.stage = v_from and e.completed_at is not null
        and length(trim(e.conclusion)) > 0 and e.decision is not null
    ) then raise exception 'COMPLETED_EXPERIMENT_REQUIRED'; end if;
    select count(*) into v_metric_missing from public.metrics m
    where m.project_id = p_project_id and m.stage = v_from and m.is_key
      and public.metric_status(m.id) <> '达标';
    if v_metric_missing > 0 then raise exception 'KEY_METRICS_NOT_MET:%', v_metric_missing; end if;
  end if;

  if p_target_stage < v_from and v_reason is null then raise exception 'ROLLBACK_REASON_REQUIRED'; end if;
  if abs(p_target_stage - v_from) > 1 and v_reason is null then raise exception 'CROSS_STAGE_REASON_REQUIRED'; end if;
  v_type := case when p_target_stage < v_from then 'rollback' when p_target_stage = v_from + 1 then 'advance' else 'cross_stage' end;
  v_reason := coalesce(v_reason, '当前阶段门槛、验证实验与关键指标均已完成');
  update public.projects set stage = p_target_stage::smallint where id = p_project_id;
  insert into public.stage_history (project_id, from_stage, to_stage, change_type, reason, actor_email)
  values (p_project_id, v_from, p_target_stage::smallint, v_type, v_reason, v_actor);
  insert into public.activity_logs (project_id, type, text, actor_email)
  values (p_project_id, '阶段流转', format('项目「%s」从「%s」调整至「%s」：%s', v_name,
    (array['立项','趋势验证','Demo MVP','小流量测试','规模转化'])[v_from + 1],
    (array['立项','趋势验证','Demo MVP','小流量测试','规模转化'])[p_target_stage + 1], v_reason), v_actor);
end;
$$;

grant execute on function public.change_project_stage(uuid, integer, text) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.metric_observations;
exception when duplicate_object then null;
end $$;

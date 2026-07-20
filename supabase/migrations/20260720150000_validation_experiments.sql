-- Multi-round validation experiments: hypothesis -> evidence -> conclusion -> decision.

create table if not exists public.validation_experiments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  round_no integer not null,
  stage smallint not null check (stage between 0 and 4),
  hypothesis text not null check (length(trim(hypothesis)) > 0),
  target_user text not null check (length(trim(target_user)) > 0),
  method text not null check (length(trim(method)) > 0),
  threshold_operator text not null check (threshold_operator in ('>=', '>', '<=', '<', '=')),
  threshold_value numeric not null,
  threshold_unit text not null check (length(trim(threshold_unit)) > 0),
  start_date date not null,
  end_date date not null,
  actual_value numeric,
  actual_data text not null default '',
  data_source text not null default '',
  threshold_met boolean,
  conclusion text not null default '',
  decision text check (decision is null or decision in ('继续验证', '进入下一阶段', '调整方向', '暂停', '终止', '规模化')),
  key_learning text not null default '',
  completed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, round_no),
  check (end_date >= start_date)
);

create or replace function public.prepare_validation_experiment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage smallint;
begin
  if tg_op = 'INSERT' then
    select stage into v_stage from public.projects where id = new.project_id and deleted_at is null;
    if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
    new.stage := v_stage;
    select coalesce(max(round_no), 0) + 1 into new.round_no
    from public.validation_experiments where project_id = new.project_id;
    new.created_by := coalesce(auth.jwt() ->> 'email', new.created_by, 'unknown');
  else
    if new.project_id <> old.project_id or new.stage <> old.stage or new.round_no <> old.round_no then
      raise exception 'EXPERIMENT_IDENTITY_IMMUTABLE';
    end if;
  end if;

  if new.actual_value is null then
    new.threshold_met := null;
  else
    new.threshold_met := case new.threshold_operator
      when '>=' then new.actual_value >= new.threshold_value
      when '>' then new.actual_value > new.threshold_value
      when '<=' then new.actual_value <= new.threshold_value
      when '<' then new.actual_value < new.threshold_value
      when '=' then new.actual_value = new.threshold_value
    end;
  end if;

  if new.completed_at is not null and (
    new.actual_value is null or length(trim(new.actual_data)) = 0 or length(trim(new.data_source)) = 0 or
    length(trim(new.conclusion)) = 0 or new.decision is null or length(trim(new.key_learning)) = 0
  ) then
    raise exception 'EXPERIMENT_RESULT_INCOMPLETE';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists validation_experiments_prepare on public.validation_experiments;
create trigger validation_experiments_prepare before insert or update on public.validation_experiments
for each row execute function public.prepare_validation_experiment();

alter table public.validation_experiments enable row level security;
drop policy if exists "Public can read active validation experiments" on public.validation_experiments;
create policy "Public can read active validation experiments" on public.validation_experiments
for select using (exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null));
drop policy if exists "Admin manages validation experiments" on public.validation_experiments;
create policy "Admin manages validation experiments" on public.validation_experiments for all
using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());

grant select on public.validation_experiments to anon;
grant select, insert, update, delete on public.validation_experiments to authenticated;

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
  v_type text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_actor text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not public.is_dashboard_admin() then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_target_stage is null or p_target_stage < 0 or p_target_stage > 4 then
    raise exception 'INVALID_TARGET_STAGE';
  end if;
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
    ) then
      raise exception 'COMPLETED_EXPERIMENT_REQUIRED';
    end if;
  end if;

  if p_target_stage < v_from and v_reason is null then raise exception 'ROLLBACK_REASON_REQUIRED'; end if;
  if abs(p_target_stage - v_from) > 1 and v_reason is null then raise exception 'CROSS_STAGE_REASON_REQUIRED'; end if;
  v_type := case
    when p_target_stage < v_from then 'rollback'
    when p_target_stage = v_from + 1 then 'advance'
    else 'cross_stage'
  end;
  v_reason := coalesce(v_reason, '当前阶段门槛与验证实验均已完成');
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
  alter publication supabase_realtime add table public.validation_experiments;
exception when duplicate_object then null;
end $$;
